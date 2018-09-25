var mosca = require('mosca');
var iotalib = require('@dojot/iotagent-nodejs');
var dojotLogger = require("@dojot/dojot-module-logger");
var logger = dojotLogger.logger;
var config = require('./config');

// Base iot-agent
logger.debug("Initializing IoT agent...");
var iota = new iotalib.IoTAgent();
iota.init();
logger.debug("... IoT agent was initialized");

logger.debug("Initializing configuration endpoints...");
var bodyParser = require("body-parser");
var express = require("express");
var app = express();
app.use(bodyParser.json());
dojotLogger.addLoggerEndpoint(app);
app.listen(10001, () => {
    logger.info(`Listening on port 10001.`);
});
logger.debug("... configuration endpoints were initialized");

// Local device cache
//
// Once a MQTT client is authorized by the server, 
// its corresponding dojot device is added to the cache
// and kept there while the client is connected.
// The clientId which MUST match the pattern tenant:deviceId
// is used as the cache's key.
const cache = new Map();

// Mosca Settings
var moscaSettings = {};

var mosca_backend = {
  type: 'redis',
  redis: require('redis'),
  db: 12,
  port: config.backend_port,
  return_buffers: true, // to handle binary payloads
  host: config.backend_host
};

// MQTT with TLS and client certificate
if (config.mosca_tls.enabled === 'true') {

  moscaSettings = {
    backend: mosca_backend,
    persistence: {
      factory: mosca.persistence.Redis,
      host: mosca_backend.host
    },
    type: "mqtts", // important to only use mqtts, not mqtt
    credentials:
    { // contains all security information
      keyPath: config.mosca_tls.key,
      certPath: config.mosca_tls.cert,
      caPaths: [config.mosca_tls.ca],
      requestCert: true, // enable requesting certificate from clients
      rejectUnauthorized: true // only accept clients with valid certificate
    },
    secure: {
      port: 8883  // 8883 is the standard mqtts port
    }
  };
}
// MQTT without TLS 
// (should only be used for debugging purposes or in a private environment)
else {
  moscaSettings = {
    port: 1883,
    backend: mosca_backend,
    persistence: {
      factory: mosca.persistence.Redis,
      host: mosca_backend.host
    }
  };
}

var server = new mosca.Server(moscaSettings);

// Fired when mosca server is ready
server.on('ready', () => {
  logger.info('Mosca server is up and running');
  // callbacks
  if (config.mosca_tls.enabled === 'true') {
    server.authenticate = authenticate;
  }
  // Always check whether device is doing the right thing.
  server.authorizePublish = authorizePublish;
  server.authorizeSubscribe = authorizeSubscribe;
});

// Helper Function to parse MQTT clientId
function parseClientIdOrTopic(clientId, topic) {
  if (clientId && (typeof clientId === 'string')) {
    let parsedData = clientId.match(/^(\w+):(\w+)$/);
    if (parsedData) {
      return { tenant: parsedData[1], device: parsedData[2] };
    }
  }

  // If we're here, it means that TLS is not configured
  // so fallback to topic-based id scheme
  result = topic.match(/^\/([^/]+)\/([^/]+)/)
  if (result) {
    let exist = false;
    logger.debug(`will attempt to use topic as tenant source ${result}`);
    exist = iota.messenger.tenants.some((tenant) => {
      if (result[1] === tenant) {
        return true;
      }
    });
    if (exist) {
      return ({ tenant: result[1], device: result[2] });
    }
    logger.debug(`invalid tenant: ${result[1]}`);
    return;
  }
  return;
}

// Function to authenticate the MQTT client
function authenticate(client, username, password, callback) {
  logger.debug('Authenticating MQTT client', client.id);

  // Condition 1: client.id follows the pattern tenant:deviceId
  // Get tenant and deviceId from client.id
  let ids = parseClientIdOrTopic(client.id);
  if (!ids) {
    //reject client connection
    callback(null, false);
    logger.warn(`Connection rejected for ${client.id}. Invalid clientId.`);
    return;
  }

  // Condition 2: Client certificate belongs to the
  // device identified in the clientId
  // TODO: the clientId must contain the tenant too!
  if (config.mosca_tls.enabled === 'true') {
    clientCertificate = client.connection.stream.getPeerCertificate();
    if (!clientCertificate.hasOwnProperty('subject') ||
      !clientCertificate.subject.hasOwnProperty('CN') ||
      clientCertificate.subject.CN !== ids.device) {
      //reject client connection
      callback(null, false);
      logger.warn(`Connection rejected for ${client.id}. Invalid client certificate.`);
      return;
    }
  }

  // Condition 3: Device exists in dojot
  iota.getDevice(ids.device, ids.tenant).then((device) => {
    // add device to cache
    cache.set(client.id, { client });
    //authorize client connection
    callback(null, true);
    logger.debug('Connection authorized for', client.id);
  }).catch((error) => {
    //reject client connection
    callback(null, false);
    logger.warn(`Connection rejected for ${client.id}. Device doesn't exist in dojot.`);
  })
}

// Function to authourize client to publish to
// topic: {tenant}/{deviceId}/attrs
function authorizePublish(client, topic, payload, callback) {
  logger.debug(`Authorizing MQTT client ${client.id} to publish to ${topic}`);

  let ids = parseClientIdOrTopic(client.id, topic);
  if (!ids) {
    callback(null, false);
    logger.warn(`Rejected client ${client.id} to publish to topic ${topic}`);
    return;
  }
  let expectedTopic = `/${ids.tenant}/${ids.device}/attrs`;

  logger.debug(`Expected topic is ${expectedTopic}`);
  logger.debug(`Device published on topic ${topic}`);
  if (topic === expectedTopic) {
    // authorize
    callback(null, true);
    logger.debug(`Authorized client ${client.id} to publish to topic ${topic}`);
    return;
  }

  //reject
  callback(null, false);
  logger.warn(`Rejected client ${client.id} to publish to topic ${topic}`);
}

// Function to authorize client to subscribe to
// topic: {tenant}/{deviceId}/config
function authorizeSubscribe(client, topic, callback) {
  logger.debug(`Authorizing client ${client.id} to subscribe to ${topic}`);

  let ids = parseClientIdOrTopic(client.id, topic);
  if (!ids) {
    //reject client connection
    callback(null, false);
    logger.warn(`Connection rejected for ${client.id}. Invalid clientId.`);
    return;
  }

  let expectedTopic = `/${ids.tenant}/${ids.device}/config`;

  if (topic === expectedTopic) {
    // authorize
    callback(null, true);
    logger.debug(`Authorized client ${client.id} to subscribe to topic ${topic}`);
    return;
  }

  //reject
  callback(null, false);
  logger.warn(`Rejected client ${client.id} to subscribe to topic ${topic}`);
}

// Fired when a client connects to mosca server
server.on('clientConnected', function (client) {
  logger.info('client up', client.id);
  // TODO: notify dojot that device is online?
});

// Fired when a client disconnects from mosca server
server.on('clientDisconnected', function (client) {
  logger.info('client down', client.id);
  // delete device from cache
  cache.delete(client.id);
});

// Fired when a message is received by mosca server
// (from device to dojot)
server.on('published', function (packet, client) {

  // ignore meta (internal) topics
  if ((packet.topic.split('/')[0] == '$SYS') ||
    (client === undefined) || (client === null)) {
    logger.debug('ignoring internal message', packet.topic, client);
    return;
  }

  // handle packet
  let data;
  try {
    data = JSON.parse(packet.payload.toString());
  }
  catch (e) {
    logger.warn('Payload is not valid JSON. Ignoring.', packet.payload.toString(), e);
  }

  logger.debug('Published', packet.topic, data, client.id);

  //TODO: support only ISO string???
  let metadata = {};
  if ("timestamp" in data) {
    metadata = { timestamp: 0 };
    // If it is a number, just copy it. Probably Unix time.
    if (typeof data.timestamp === "number") {
      if (!isNaN(data.timestamp)) {
        metadata.timestamp = data.timestamp;
      }
      else {
        logger.warn("Received an invalid timestamp (NaN)");
        metadata = {};
      }
    }
    else {
      // If it is a ISO string...
      const parsed = Date.parse(data.timestamp);
      if (!isNaN(parsed)) {
        metadata.timestamp = parsed;
      }
      else {
        // Invalid timestamp.
        metadata = {};
      }
    }
  }
  //send data to dojot broker
  let ids = parseClientIdOrTopic(client.id, packet.topic);
  iota.updateAttrs(ids.device, ids.tenant, data, metadata);
});

// Fired when a device.configure event is received
// (from dojot to device)
iota.messenger.on('iotagent.device', 'device.configure', (tenant, event) => {
  logger.debug('Got configure event from Device Manager', event)
  // device id
  let deviceId = event.data.id;
  delete event.data.id;

  // topic
  // For now, we are still using slashes at the beginning. In the future, 
  // this will be removed (and topics will look like 'admin/efac/config')
  // let topic = `${tenant}/${deviceId}/config`;
  let topic = `/${tenant}/${deviceId}/config`;

  // device
  let cacheEntry = cache.get(`${tenant}:${deviceId}`);
  if (cacheEntry) {
    let message = {
      'topic': topic,
      'payload': JSON.stringify(event.data.attrs),
      'qos': 0,
      'retain': false
    };

    // send data to device
    logger.debug('Publishing', message)
    server.publish(message, () => { logger.debug('Message out!!') });

    // TODO: send message/state(=sent) to history
  }
  else {
    logger.debug(`Discading event because device is disconnected`);
    // TODO: send message/state(=discarded) to history
  }

});

const deleteAndDisconnectCacheDevice = (event) => {
  const id = event.data.id;
  const tenant = event.meta.service;
  let cacheEntry = cache.get(`${tenant}:${id}`);
  if (cacheEntry) {
    let { client } = cache.get(`${tenant}:${id}`);
    if (client) {
      client.close();
    }
    cache.delete(`${tenant}:${id}`);
  }
}

// // Fired when a device.remove event is received
iota.messenger.on('iotagent.device', 'device.remove', (tenant, event) => {
  logger.debug('Got device.remove event from Device Manager', tenant);
  deleteAndDisconnectCacheDevice(event);
});
