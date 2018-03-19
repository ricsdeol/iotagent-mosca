'use strict';

var config = {};

config.backend_host = process.env.BACKEND_HOST || 'mosca-redis'
config.backend_port = process.env.BACKEND_PORT || 6379

module.exports = config;
