var mosca = require('mosca');
var iotalib = require('dojot-iotagent');
var config = require('./config');

// Base iot-agent
var iota = new iotalib.IoTAgent();
iota.init();

// Local device cache
//
// Once a MQTT client is authorized by the server, 
// its corresponding dojot device is added to the cache
// and kept there while the client is connected.
// The clientId which MUST match the pattern tenant/deviceId
// is used as the cache's key.
//
// TODO: Replace the map by a list of connected device Ids?
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
if (config.mosca_tls === 'true') {

  // TODO: move to config.js
  // TODO: change names from mosquitto* to mosca*
  var SECURE_CERT = '/opt/mosca/certs/mosquitto.crt';
  var SECURE_KEY =  '/opt/mosca/certs/mosquitto.key';
  var CA_CERT = '/opt/mosca/certs/ca.crt';

  moscaSettings = {
    backend: mosca_backend,
    persistence: {
      factory: mosca.persistence.Redis,
      host: mosca_backend.host
    },
    type : "mqtts", // important to only use mqtts, not mqtt
    credentials :
    { // contains all security information
        keyPath: SECURE_KEY,
        certPath: SECURE_CERT,
        caPaths : [ CA_CERT ],
        requestCert : true, // enable requesting certificate from clients
        rejectUnauthorized : true // only accept clients with valid certificate
    },
    secure : {
        port : 8883  // 8883 is the standard mqtts port
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
  console.log('Mosca server is up and running');
  
  // callbacks
  server.authenticate = authenticate;
  server.authorizePublish = authorizePublish;
  server.authorizeSubscribe = authorizeSubscribe;
})

// Helper Function to parse MQTT clientId
// (pattern: clientId = tenant/deviceId)
function parseClientId(clientId) {
  if (clientId && (typeof clientId === 'string')) {
    let parsedData = clientId.match(/^(\w+)\/(\w+)$/);
    if (parsedData) {
      return {tenant: parsedData[1], device: parsedData[2]};
    }
  }
}

// Function to authenticate the MQTT client 
function authenticate(client, username, password, callback) {
  console.log('Authenticating MQTT client', client.id);

  // Condition 1: client.id follows the pattern tenant/deviceId
  // Get tenant and deviceId from client.id
  let ids = parseClientId(client.id);
  if (!ids) {
    //reject client connection
    callback(null, false);
    console.log(`Connection rejected for ${client.id}. Invalid clientId.`);
    return;
  }
  
  // Condition 2: Client certificate belongs to the
  // device identified in the clientId
  // TODO: the clientId must contain the tenant too!
  clientCertificate = client.connection.stream.getPeerCertificate();
  if (!clientCertificate.hasOwnProperty('subject') ||
      !clientCertificate.subject.hasOwnProperty('CN') &&
      clientCertificate.subject.CN !== ids.device) {
        //reject client connection
        callback(null, false);
        console.log(`Connection rejected for ${client.id}. Invalid client certificate.`);
        return;
    }
    
  // Condition 3: Device exists in dojot
  iota.getDevice(ids.device, ids.tenant).then((device) => {
    // add device to cache
    device.auto = false;
    cache.set(client.id, device);
    //authorize client connection
    callback(null, true);
    console.log('Connection authorized for', client.id);
  }).catch((error) => {
    //reject client connection
    callback(null, false);
    console.log(`Connection rejected for ${client.id}. Device doesn\'t exist in dojot.`);
  })
}

// Function to authourize client to publish to
// topic: {tenant}/{deviceId}/attrs
function authorizePublish(client, topic, payload, callback) {
  console.log(`Authorizing MQTT client ${client.id} to publish to ${topic}`);

  let ids = parseClientId(client.id);
  let expectedTopic = `${ids.tenant}/${ids.device}/attrs`
  if (topic === expectedTopic) {
    // authorize
    callback(null, true);
    console.log(`Authorized client ${client.id} to publish to topic ${topic}`);
    return;
  }
  
  //reject
  callback(null, false);
  console.log(`Rejected client ${client.id} to publish to topic ${topic}`);
}

// Function to authorize client to subscribe to
// topic: {tenant}/{deviceId}/config
function authorizeSubscribe(client, topic, callback) {
  console.log(`Authorizing client ${client.id} to subscribe to ${topic}`);

  let ids = parseClientId(client.id);
  let expectedTopic = `${ids.tenant}/${ids.device}/config`
  if (topic === expectedTopic) {
    // authorize
    callback(null, true);
    console.log(`Authorized client ${client.id} to subscribe to topic ${topic}`);
    return;
  }
  
  //reject
  callback(null, false);
  console.log(`Rejected client ${client.id} to subscribe to topic ${topic}`);
}

// Fired when a client connects to mosca server
server.on('clientConnected', function(client) {
  console.log('client up', client.id);
  // TODO: notify dojot that device is online?
});

// Fired when a client disconnects from mosca server
server.on('clientDisconnected', function(client) {
  console.log('client down', client.id);  
  //TODO: notify dojot that device is offline?
});

// Fired when a message is received by mosca server
// (from device to dojot)
server.on('published', function(packet, client) {
  // ignore meta (internal) topics
  if ((packet.topic.split('/')[0] == '$SYS') || 
      (client === undefined) || (client === null)) {
    console.log('ignoring internal message', packet.topic, client);
    return;
  }

  // handle packet
  let data;
  try {
    data = JSON.parse(packet.payload.toString());
  }
  catch (e) {
    console.log('Payload is not valid JSON. Ignoring.', packet.payload.toString(), e);
  }
  
  console.log('Published', packet.topic, data, client.id);

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
        console.log("Received an invalid timestamp (NaN)");
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
  let ids = parseClientId(client.id);
  iota.updateAttrs(ids.device, ids.tenant, data, metadata);
});

// Fired when a device.configure event is received
// (from dojot to device)
iota.on('device.configure', (event) => {
  console.log('Got configure event from Device Manager', event)
  
  // device id
  let deviceId = event.data.id;
  delete event.data.id;

  // tenant
  let tenant = event.meta.service;

  // topic
  let topic = `${tenant}/${deviceId}/config`;
  
  // device
  let device = cache.get(`${tenant}/${deviceId}`);
  if (device) {
    let message = {
      'topic': topic,
      'payload': JSON.stringify(event.data.attrs),
      'qos': 0,
      'retain': false
    };
    
    // send data to device
    console.log('Publishing', message)
    server.publish(message, () => { console.log('Message out!!')});

    // TODO: send message/state(=sent) to history
  }
  else {
    console.log(`Discading event because device is disconnected`);
    // TODO: send message/state(=discarded) to history
  }

});

const updateCacheDevice = (event) => {
  const id = event.data.id;
  const tenant = event.meta.service;
  const device = cache.get(`${tenant}/${id}`);
  if (device) {
    for (const key in event.data) {
      if (device.hasOwnProperty(key)) {
        device[key] = event.data[key];
      }
    }
    cache.set(`${tenant}/${id}`, device);
  } else {
    console.log("Device not exist in cache ..");
  }
}

const deleteCacheDevice = (event) => {
  const id = event.data.id;
  const tenant = event.meta.service;
  cache.delete(`${tenant}/${id}`);
}

// Fired when a device.update event is received
iota.on('device.update', (event) => {
  console.log('Got device.update event from Device Manager', event);
    updateCacheDevice(event);
});

// Fired when a device.remove event is received
iota.on('device.remove', (event) => {
  console.log('Got device.remove event from Device Manager', event);
  deleteCacheDevice(event);
});