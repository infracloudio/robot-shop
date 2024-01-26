const axios = require('axios');
const bodyParser = require('body-parser');
const express = require('express');
const expPino = require('express-pino-logger');
const promMid = require('express-prometheus-middleware');
const pino = require('pino');
const redis = require('redis');

// Prometheus
const promClient = require('prom-client');
const Registry = promClient.Registry;
const register = new Registry();
const counter = new promClient.Counter({
    name: 'items_added',
    help: 'running count of items added to cart',
    registers: [register]
});

// Redis
var redisConnected = false;
var redisHost = process.env.REDIS_HOST || 'redis'
var catalogueHost = process.env.CATALOGUE_HOST || 'catalogue'

const logger = pino({
    level: 'warn',
    prettyPrint: false,
    formatters: {
      level: (label) => {
        return { level: label };
      },
    }
});
const expLogger = expPino({
    logger: logger
});

const app = express();

app.use(expLogger);

app.use((req, res, next) => {
    res.set('Timing-Allow-Origin', '*');
    res.set('Access-Control-Allow-Origin', '*');
    next();
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.get('/health', (req, res) => {
    var stat = {
        app: 'OK',
        redis: redisConnected
    };
    res.json(stat);
});

app.use(promMid({
    metricsPath: '/metrics',
    collectDefaultMetrics: true,
    requestDurationBuckets: [0.1, 0.5, 1, 1.5],
    requestLengthBuckets: [512, 1024, 5120, 10240, 51200, 102400],
    responseLengthBuckets: [512, 1024, 5120, 10240, 51200, 102400],
    /**
     * Uncomenting the `authenticate` callback will make the `metricsPath` route
     * require authentication. This authentication callback can make a simple
     * basic auth test, or even query a remote server to validate access.
     * To access /metrics you could do:
     * curl -X GET user:password@localhost:9091/metrics
     */
    // authenticate: req => req.headers.authorization === 'Basic dXNlcjpwYXNzd29yZA==',
    /**
     * Uncommenting the `extraMasks` config will use the list of regexes to
     * reformat URL path names and replace the values found with a placeholder value
     */
    extraMasks: ['^anonymous.[0-9]+$'],
    /**
     * The prefix option will cause all metrics to have the given prefix.
     * E.g.: `app_prefix_http_requests_total`
     */
    // prefix: 'app_prefix_',
    /**
     * Can add custom labels with customLabels and transformLabels options
     */
    // customLabels: ['contentType'],
    // transformLabels(labels, req) {
    //   // eslint-disable-next-line no-param-reassign
    //   labels.contentType = req.headers['content-type'];
    // },
}));

app.get('/ready', (req, res) => {
    if(redisConnected) {
        res.send('ready');
    } else {
        res.status(404).send('not ready');
    }
});

// get cart with id
app.get('/cart/:id', (req, res) => {
    if(redisConnected) {
        redisClient.get(req.params.id).then(
            (val) => {
                if(val == null) {
                    res.status(404).send('cart not found');
                } else {
                    res.type('json');
                    res.send(val);
                }
            },
            (err) => {
                req.log.error(err);
                res.status(500).send(err);
            }
        );
    } else {
        res.status(500).send('Redis not available');
    }
});

// delete cart with id
app.delete('/cart/:id', (req, res) => {
    try {
        if (req.query.error === 'True') {
            throw new Error('Invalid cart id: ' + req.params.id);
        }
    } catch(e) {
        logger.error(e);
        res.status(500).send(e);
        return;
    }

    redisClient.del(req.params.id).then((val) => {
            if(val == 1) {
                res.send('OK');
            } else {
                res.status(404).send('cart not found');
            }
        }).catch((err) => {
            req.log.error(err);
            res.status(500).send(e);
        }
    );
});

// rename cart i.e. at login
app.get('/rename/:from/:to', (req, res) => {
    redisClient.get(req.params.from).then(
        (val) => {
            if(val == null) {
                res.status(404).send('cart not found');
            } else {
                var cart = JSON.parse(val);
                saveCart(req.params.to, cart).then((val) => {
                        redisClient.del(req.params.from).then((val) => {
                            req.log.info('delete cart %o', val);
                        }).catch((err) => {
                            req.log.error(err);
                        });
                        res.json(cart);
                    }).catch((err) => {
                        req.log.error(err);
                        res.status(500).send(err);
                    });
            }
        }).catch((err) => {
            req.log.error(err);
            res.status(500).send(err);
        });
});

// update/create cart
app.get('/add/:id/:sku/:qty', (req, res) => {
    // check quantity
    var qty = parseInt(req.params.qty);
    if(isNaN(qty)) {
        req.log.warn('quantity not a number');
        res.status(400).send('quantity must be a number');
        return;
    } else if(qty < 1) {
        req.log.warn('quantity less than one');
        res.status(400).send('quantity has to be greater than zero');
        return;
    }

    // look up product details
    getProduct(req.params.sku).then((product) => {
        req.log.info('got product %o', product);
        if(!product) {
            res.status(404).send('product not found');
            return;
        }
        // is the product in stock?
        if(product.instock == 0) {
            res.status(404).send('out of stock');
            return;
        }
        // does the cart already exist?
        redisClient.get(req.params.id).then((data) => {
            var cart;
            if(data == null) {
                // create new cart
                cart = {
                    total: 0,
                    tax: 0,
                    items: []
                };
            } else {
                cart = JSON.parse(data);
            }
            req.log.info('got cart %o', cart);
            // add sku to cart
            var item = {
                qty: qty,
                sku: req.params.sku,
                name: product.name,
                price: product.price,
                subtotal: qty * product.price
            };
            var list = mergeList(cart.items, item, qty);
            cart.items = list;
            cart.total = calcTotal(cart.items);
            // work out tax
            cart.tax = calcTax(cart.total);

            // save the new cart
            saveCart(req.params.id, cart).then((data) => {
                counter.inc(qty);
                res.json(cart);
            }).catch((err) => {
                req.log.error(err);
                res.status(500).send(err);
            });
        }).catch((err) => {
            req.log.error(err);
            res.status(500).send(err);
        });
    }).catch((err) => {
        req.log.error(err);
        res.status(500).send(err);
    });
});

// update quantity - remove item when qty == 0
app.get('/update/:id/:sku/:qty', (req, res) => {
    // check quantity
    var qty = parseInt(req.params.qty);
    if(isNaN(qty)) {
        req.log.warn('quanity not a number');
        res.status(400).send('quantity must be a number');
        return;
    } else if(qty < 0) {
        req.log.warn('quantity less than zero');
        res.status(400).send('negative quantity not allowed');
        return;
    }

    // get the cart
    redisClient.get(req.params.id).then((data) => {
        if(data == null) {
            res.status(404).send('cart not found');
        } else {
            var cart = JSON.parse(data);
            var idx;
            var len = cart.items.length;
            for(idx = 0; idx < len; idx++) {
                if(cart.items[idx].sku == req.params.sku) {
                    break;
                }
            }
            if(idx == len) {
                // not in list
                res.status(404).send('not in cart');
            } else {
                if(qty == 0) {
                    cart.items.splice(idx, 1);
                } else {
                    if(qty > cart.items[idx].qty) {
                        counter.inc(qty - cart.items[idx].qty)
                    }
                    cart.items[idx].qty = qty;
                    cart.items[idx].subtotal = cart.items[idx].price * qty;
                }
                cart.total = calcTotal(cart.items);
                // work out tax
                cart.tax = calcTax(cart.total);
                saveCart(req.params.id, cart).then((data) => {
                    res.json(cart);
                }).catch((err) => {
                    req.log.error(err);
                    res.status(500).send(err);
                });
            }
        }
    }).catch((err) => {
        req.log.error(err);
        res.status(500).send(err);
    });
});

// add shipping
app.post('/shipping/:id', (req, res) => {
    var shipping = req.body;
    if(shipping.distance === undefined || shipping.cost === undefined || shipping.location == undefined) {
        req.log.warn('shipping data missing', shipping);
        res.status(400).send('shipping data missing');
    } else {
        // get the cart
        redisClient.get(req.params.id).then((data) => {
            if(data == null) {
                req.log.info('no cart for ' + req.params.id);
                res.status(404).send('cart not found');
            } else {
                var cart = JSON.parse(data);
                var item = {
                    qty: 1,
                    sku: 'SHIP',
                    name: 'shipping to ' + shipping.location,
                    price: shipping.cost,
                    subtotal: shipping.cost
                };
                // check shipping already in the cart
                var idx;
                var len = cart.items.length;
                for(idx = 0; idx < len; idx++) {
                    if(cart.items[idx].sku == item.sku) {
                        break;
                    }
                }
                if(idx == len) {
                    // not already in cart
                    cart.items.push(item);
                } else {
                    cart.items[idx] = item;
                }
                cart.total = calcTotal(cart.items);
                // work out tax
                cart.tax = calcTax(cart.total);

                // save the updated cart
                saveCart(req.params.id, cart).then((data) => {
                    res.json(cart);
                }).catch((err) => {
                    req.log.error(err);
                    res.status(500).send(err);
                });
            }
        }).catch((err) => {
            req.log.error(err);
            res.status(500).send(err);
        });
    }
});

function mergeList(list, product, qty) {
    var inlist = false;
    // loop through looking for sku
    var idx;
    var len = list.length;
    for(idx = 0; idx < len; idx++) {
        if(list[idx].sku == product.sku) {
            inlist = true;
            break;
        }
    }

    if(inlist) {
        list[idx].qty += qty;
        list[idx].subtotal = list[idx].price * list[idx].qty;
    } else {
        list.push(product);
    }

    return list;
}

function calcTotal(list) {
    var total = 0;
    for(var idx = 0, len = list.length; idx < len; idx++) {
        total += list[idx].subtotal;
    }

    return total;
}

function calcTax(total) {
    // tax @ 20%
    return (total - (total / 1.2));
}

function getProduct(sku) {
    return new Promise((resolve, reject) => {
        axios.get('http://' + catalogueHost + ':8080/product/' + sku).then((res) => {
            // return a product object
            // axios automatically converts json to object
            if(res.status != 200) {
                resolve(null);
            } else {
                resolve(res.data);
            }
        }).catch((err) => {
            reject(err);
        });
    });
}

function saveCart(id, cart) {
    logger.info('saving cart %o', cart);
    return redisClient.SETEX(id, 3600, JSON.stringify(cart));
}

// connect to Redis
logger.info('Connecting to redis host %s', redisHost);
var redisClient = redis.createClient({
    url: 'redis://' + redisHost
});

redisClient.on('error', (e) => {
    logger.error('Redis ERROR %o', e);
});
redisClient.on('ready', () => {
    logger.info('Redis READY');
    redisConnected = true;
});

redisClient.connect();

// fire it up!
const port = process.env.CART_SERVER_PORT || '8080';
app.listen(port, () => {
    logger.info('Started on port %s', port);
});
