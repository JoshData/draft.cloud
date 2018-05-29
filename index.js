var fs = require('fs');
var http = require('http');
var https = require('https');
var express = require('express');

// Load local settings.
var settings = JSON.parse(fs.readFileSync("local/environment.json"))

// Prep the database.
require("./backend/models.js")
  .initialize_database(settings, function() {

  // Start the HTTP server.
  var app = express();
  var sessionStore = require('express-session').MemoryStore;
    sessionStore = new sessionStore();

  // General expresss settings.
  if (settings.trust_proxy) app.set('trust proxy', settings.trust_proxy); // express won't set secure cookies if it can't see it's running behind https
  app.use(require('helmet')())

  // Initialize the back-end API routes.
  require("./backend/routes.js")
    .create_routes(app, settings);

  // Initialize the front-end web routes.
  require("./frontend/routes.js")
    .create_routes(app, sessionStore, settings);

  // Start listening.
  var bind = settings.bind || "127.0.0.1";
  var port = settings.port || 8000;
  console.log("Starting on " + bind + ":" + port + ".");
  var server;
  if (!settings.tls) {
    server = http.createServer(app);
  } else {
    var options = { key: fs.readFileSync(settings.tls.key),
                cert: fs.readFileSync(settings.tls.cert) };
    server = https.createServer(options, app);
  }
  server.listen(port, bind);

  // Initialize the back-end websocket handler, which must be
  // after we start listening.
  var websocketio = require('socket.io').listen(server);
  require("./backend/live.js")
    .init(websocketio, sessionStore, settings);

  // Initialize the front-end.
  app.use('', express.static(require('path').join(__dirname, 'public_html')))

});

