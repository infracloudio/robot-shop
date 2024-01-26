package com.instana.robotshop.shipping;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.Calendar;

@Component
public class BuildInfo {
    private static final Logger logger = LoggerFactory.getLogger(BuildInfo.class);
    private static final String TAG_BRANCH = "branch";
    private static final String TAG_REVISION = "revision";
    private static final String TAG_VERSION = "version";
    private static final String GOOD_BUILD_REVISION = "e5ff814cb0940bb24bdfeaa2edfa42cf084480d7";
    private static final String GOOD_BUILD_VERSION = "2.1.1";
    private static final String BAD_BUILD_REVISION = "55292e2199f2fb00a165b1f7d3045fe7f8922038";
    private static final String BAD_BUILD_VERSION = "2.1.0";

    private final MeterRegistry meterRegistry;
    private Gauge buildInfoGauge;
    private final Integer failureHour;
    private final int failureStartMin;
    private final int failureEndMin;

    public BuildInfo(MeterRegistry meterRegistry,
                     @Value("${FAILURE_HOUR:#{null}}") Integer failureHour,
                     @Value("${FAILURE_FROM_MINUTE:0}") int failureStartMin,
                     @Value("${FAILURE_TILL_MINUTE:15}") int failureEndMin) {
        this.meterRegistry = meterRegistry;
        this.failureHour = failureHour;
        this.failureStartMin = failureStartMin;
        this.failureEndMin = failureEndMin;
        logger.info("Failure hour - {}, failure start minute - {}, failure end minute - {}",
                failureHour, failureStartMin, failureEndMin);
    }

    @Scheduled(fixedDelay = 10000)
    public void run() {
        LocalDateTime now = LocalDateTime.now();
        if (now.getHour() == getFailureHour() && now.getMinute() >= failureStartMin && now.getMinute() < failureEndMin) {
            if (buildInfoGauge != null && GOOD_BUILD_VERSION.equals(buildInfoGauge.getId().getTag(TAG_VERSION))) {
                logger.info("Shipping failure scenario - begin");
                meterRegistry.remove(buildInfoGauge);
            }
            buildInfoGauge = registerBadBuild();
        } else {
            if (buildInfoGauge != null && BAD_BUILD_VERSION.equals(buildInfoGauge.getId().getTag(TAG_VERSION))) {
                logger.info("Shipping failure scenario - end");
                meterRegistry.remove(buildInfoGauge);
            }
            buildInfoGauge = registerGoodBuild();
        }
    }

    private Integer getFailureHour() {
        return failureHour != null ? failureHour : Calendar.getInstance().get(Calendar.DAY_OF_MONTH) % 16;
    }

    private Gauge registerGoodBuild() {
        return registerBuild(GOOD_BUILD_REVISION, GOOD_BUILD_VERSION);
    }

    private Gauge registerBadBuild() {
        return registerBuild(BAD_BUILD_REVISION, BAD_BUILD_VERSION);
    }

    private Gauge registerBuild(String revision, String version) {
        return Gauge.builder("shipping_build_info", () -> 1)
                .description("Shipping build info")
                .tag(TAG_BRANCH, "HEAD")
                .tag(TAG_REVISION, revision)
                .tag(TAG_VERSION, version)
                .register(meterRegistry);
    }
}
