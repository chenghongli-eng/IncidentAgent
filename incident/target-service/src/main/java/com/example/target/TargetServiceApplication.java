package com.example.target;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class TargetServiceApplication {
    public static void main(String[] args) {
        SpringApplication.run(TargetServiceApplication.class, args);
    }
}