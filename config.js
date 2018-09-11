'use strict';

var config = {};

config.backend_host = process.env.BACKEND_HOST || 'mosca-redis'
config.backend_port = process.env.BACKEND_PORT || 6379

config.mosca_tls = {
    enabled: process.env.MOSCA_TLS || 'false',
    cert: process.env.MOSCA_TLS_SECURE_CERT || '/opt/mosca/certs/mosca.crt',
    key: process.env.MOSCA_TLS_SECURE_KEY || '/opt/mosca/certs/mosca.key',
    ca: process.env.MOSCA_TLS_CA_CERT || '/opt/mosca/certs/ca.crt'
};

module.exports = config;
