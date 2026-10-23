package com.example.target;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

/**
 * Generates steady background traffic so a fault always turns into a measurable 5xx rate.
 * Disabled by default; enable with LOAD_ENABLED=true.
 */
@Component
public class LoadDriver {

    private static final Logger log = LoggerFactory.getLogger(LoadDriver.class);

    private final RestTemplate rest;
    private final boolean enabled;
    private final String[] paths;
    private int cursor = 0;

    public LoadDriver(
            RestTemplate rest,
            org.springframework.core.env.Environment env) {
        this.rest = rest;
        this.enabled = Boolean.parseBoolean(env.getProperty("app.load.enabled", "false"));
        String configured = env.getProperty("app.load.paths", "/api/orders/1");
        this.paths = configured.split(",");
    }

    @Scheduled(fixedDelayString = "${app.load.interval-ms:1000}")
    public void tick() {
        if (!enabled) {
            return;
        }
        String path = paths[cursor++ % paths.length];
        try {
            rest.getForEntity("http://127.0.0.1:8080" + path, String.class);
        } catch (Exception ex) {
            log.debug("load probe {} failed: {}", path, ex.toString());
        }
    }
}