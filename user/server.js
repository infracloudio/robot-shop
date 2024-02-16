const fs = require('fs');
const os = require('os');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const express = require('express');
const expPino = require('express-pino-logger');
const mongoClient = require('mongodb').MongoClient;
const promMid = require('express-prometheus-middleware');
const pino = require('pino');
const redis = require('redis');

// MongoDB
var db;
var usersCollection;
var ordersCollection;
var mongoConnected = false;

const logger = pino({
    level: 'info',
    prettyPrint: false,
    useLevelLabels: true
});
const expLogger = expPino({
    logger: logger
});

// OpenTelemetry
require('./tracing');

// Redis
var redisHost = process.env.REDIS_HOST || 'redis';
var redisConnected = false;

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
        mongo: mongoConnected,
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
    extraMasks: ['^(anonymous|partner).[0-9]+$'],
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
    if(mongoConnected && redisConnected) {
        res.send('ready');
    } else {
        res.status(404).send('not ready');
    }
});

// use REDIS INCR to track anonymous users
app.get('/uniqueid', (req, res) => {
    // get number from Redis
    if(redisConnected) {
        redisClient.incr('anonymous-counter').then((val) => {
            res.json({
                uuid: 'anonymous-' + val
            });
        }).catch((err) => {
            req.log.error(err);
            res.ststus(500).send(err);
        });
    } else {
        req.log.error('Redis not available');
        res.status(500).send('Redis not available');
    }
});

// check user exists
app.get('/check/:id', (req, res) => {
    if(mongoConnected) {
        usersCollection.findOne({name: req.params.id}).then((user) => {
            if(user) {
                res.send('OK');
            } else {
                res.status(404).send('user not found');
            }
        }).catch((e) => {
            req.log.error(e);
            res.send(500).send(e);
        });
    } else {
        req.log.error('database not available');
        res.status(500).send('database not available');
    }
});

// return all users for debugging only
app.get('/users', (req, res) => {
    if(mongoConnected) {
        usersCollection.find().toArray().then((users) => {
            res.json(users);
        }).catch((e) => {
            req.log.error(e);
            res.status(500).send(e);
        });
    } else {
        req.log.error('database not available');
        res.status(500).send('database not available');
    }
});

app.post('/login', (req, res) => {
    req.log.info('login', req.body);
    if(req.body.name === undefined || req.body.password === undefined) {
        req.log.warn('credentails not complete');
        res.status(400).send('name or passowrd not supplied');
    } else if(mongoConnected) {
        usersCollection.findOne({
            name: req.body.name,
        }).then((user) => {
            req.log.info('user %o', user);
            if(user) {
                if(user.password == req.body.password) {
                    res.json(user);
                } else {
                    res.status(404).send('incorrect password');
                }
            } else {
                res.status(404).send('name not found');
            }
        }).catch((e) => {
            req.log.error(e);
            res.status(500).send(e);
        });
    } else {
        req.log.error('database not available');
        res.status(500).send('database not available');
    }
});

// TODO - validate email address format
app.post('/register', (req, res) => {
    req.log.info('register', req.body);
    if(req.body.name === undefined || req.body.password === undefined || req.body.email === undefined) {
        req.log.warn('insufficient data');
        res.status(400).send('insufficient data');
    } else if(mongoConnected) {
        // check if name already exists
        usersCollection.findOne({name: req.body.name}).then((user) => {
            if(user) {
                req.log.warn('user already exists');
                res.status(400).send('name already exists');
            } else {
                // create new user
                usersCollection.insertOne({
                    name: req.body.name,
                    password: req.body.password,
                    email: req.body.email
                }).then((r) => {
                    req.log.info('inserted %o', r.result);
                    res.send('OK');
                }).catch((e) => {
                    req.log.error(e);
                    res.status(500).send(e);
                });
            }
        }).catch((e) => {
            req.log.error(e);
            res.status(500).send(e);
        });
    } else {
        req.log.error('database not available');
        res.status(500).send('database not available');
    }
});

app.post('/order/:id', (req, res) => {
    req.log.info('order', req.body);
    // only for registered users
    if(mongoConnected) {
        usersCollection.findOne({
            name: req.params.id
        }).then((user) => {
            if(user) {
                // found user record
                // get orders
                ordersCollection.findOne({
                    name: req.params.id
                }).then((history) => {
                    if(history) {
                        var list = history.history;
                        list.push(req.body);
                        ordersCollection.updateOne(
                            { name: req.params.id },
                            { $set: { history: list }}
                        ).then((r) => {
                            res.send('OK');
                        }).catch((e) => {
                            req.log.error(e);
                            res.status(500).send(e);
                        });
                    } else {
                        // no history
                        ordersCollection.insertOne({
                            name: req.params.id,
                            history: [ req.body ]
                        }).then((r) => {
                            res.send('OK');
                        }).catch((e) => {
                            req.log.error(e);
                            res.status(500).send(e);
                        });
                    }
                }).catch((e) => {
                    req.log.error(e);
                    res.status(500).send(e);
                });
            } else {
                res.status(404).send('name not found');
            }
        }).catch((e) => {
            req.log.error(e);
            res.status(500).send(e);
        });
    } else {
        req.log.error('database not available');
        res.status(500).send('database not available');
    }
});

app.get('/history/:id', (req, res) => {
    if(mongoConnected) {
        ordersCollection.findOne({
            name: req.params.id
        }).then((history) => {
            if(history) {
                res.json(history);
            } else {
                res.status(404).send('history not found');
            }
        }).catch((e) => {
            req.log.error(e);
            res.status(500).send(e);
        });
    } else {
        req.log.error('database not available');
        res.status(500).send('database not available');
    }
});

// Testing endpoints
app.get('/hash', (req, res) => {
    hash();
    res.send('OK\n');
});

app.get('/free', (req, res) => {
    hog = [];
    res.send('OK\n');
});

app.get('/hog', (req, res) => {
    memoryHog(10);
    res.send('OK\n');
});

app.get('/memory', (req, res) => {
    const usage = process.memoryUsage();
    data = [];
    for (let key in usage) {
        data.push(`${key}: ${Math.round(usage[key] / 1024 / 1024 * 100) / 100}MB`);
    }
    data.push(`OS Total ${Math.round(os.totalmem() / 1024 / 1024 * 100) / 100}MB`);
    data.push(`OS Free ${Math.round(os.freemem() / 1024 / 1024 * 100) / 100}MB`);
    data.push(`Hog size ${hog.length}`);
    data.push('');
    res.send(data.join('\n'));
});

// connect to Redis
logger.info('connecting to redis host %s', redisHost);
var redisClient = redis.createClient({
    url: 'redis://' + redisHost
});

redisClient.on('error', (e) => {
    logger.error('Redis ERROR %o', e);
});

redisClient.on('ready', () => {
    redisConnected = true;
    logger.info('Redis READY');
});

redisClient.connect();

// set up Mongo
function mongoConnect() {
    return new Promise((resolve, reject) => {
        var mongoURL = process.env.MONGO_URL || 'mongodb://mongodb:27017/users';
        mongoClient.connect(mongoURL, (error, client) => {
            if(error) {
                reject(error);
            } else {
                db = client.db('users');
                usersCollection = db.collection('users');
                ordersCollection = db.collection('orders');
                resolve('connected');
            }
        });
    });
}

function mongoLoop() {
    mongoConnect().then((r) => {
        mongoConnected = true;
        logger.info('MongoDB connected');
    }).catch((e) => {
        logger.error('ERROR', e);
        setTimeout(mongoLoop, 2000);
    });
}

mongoLoop();

function getData() {
    return new Promise((resolve, reject) => {
        const size = 1024 * 1024;
        fs.open('/dev/urandom', 'r', (err, fd) => {
            if (err) {
                reject(err);
            }
            let buffer = Buffer.alloc(size);
            fs.read(fd, buffer, 0, size, 0, (err, num) => {
                if (err) {
                    reject(err);
                } else {
                    fs.close(fd);
                    resolve(buffer);
                }
            });
        });
    });
}

function randRange(min, max) {
    return (Math.random() * (max - min)) + min;
}

var hog = [];
var hashCount = 0;
function memoryHog(size) {
    const hogMaxLength = 40;

    if (hog.length + size > hogMaxLength) {
        size = hogMaxLength - hog.length;
    }

    for (let i = 0; i < size; i++) {
        getData().then((b) => {
            hog.push(b);
            logger.info(`hog pushed ${hog.length}`);
        }).catch((err) => {
            logger.error(err.message);
        });
    }
}

function hogLoop() {
    if (randRange(1, 100) < 10) {
        memoryHog(10);
    }

    if (randRange(1, 100) < 5) {
        // free
        logger.info('free the hog');
        hog = [];
    }
    setTimeout(hogLoop, 10000);
}

// burn some CPU
function hash() {
    // hash uses some memory
    // free memory hog to prevent OOM
    hog = [];
    let salt = bcrypt.genSaltSync(10);
    let h = bcrypt.hashSync('i love hash browns', salt);
    //console.log(`salt: ${salt} - hash: ${h}`);
    if (hashCount++ < 2000) {
        setTimeout(hash);
    } else {
        // reset
        hashCount = 0;
    }
}

function hashLoop() {
    if (randRange(1, 100) < 2 && hashCount == 0) {
        hash();
    }
    setTimeout(hashLoop, 60000);
}

// Optionally let the hogs out - oink, oink!
if (process.env.CPU_HOG) {
    console.log('CPU hog is loose');
    setTimeout(hogLoop, 5000);
}
if (process.env.MEM_HOG) {
    console.log('memory hog is loose');
    setTimeout(hashLoop, 10000);
}

// fire it up!
const port = process.env.USER_SERVER_PORT || '8080';
app.listen(port, () => {
    logger.info('Started on port %s', port);
});

