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

  // Initialize...
  // * back-end middleware (Authorization API key header checking)
  // * front-end middleware (passport-based login/session)
  // * back-end API routes
  // * front-end web routes
  var backend = require("./backend/routes.js");
  var frontend = require("./frontend/routes.js");
  backend.add_middleware(app);
  frontend.add_middleware(app, sessionStore, settings);
  backend.create_routes(app, settings);
  frontend.create_routes(app, settings);

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

  // Register a SIGINT handler to gracefully shut down
  // the application. Some considerations:
  //
  // The HTTP server won't finish shutting down until all
  // connections are closed, but socket.io doesn't have a
  // facility to forcibly terminate connections. socket.io's
  // close() method causes clients to immediately reconnect.
  // (https://github.com/socketio/socket.io/issues/1602)
  // So we have to track open connections and do it ourself.
  //
  // The committer queue will finish up on its own once
  // it stops receiving new revisions. Node won't quit
  // until it's done, and will quit when it's done, so
  // there's nothing to do there.
  var open_connections = {};
  server.on('connection', function(conn) {
      var key = conn.remoteAddress + ':' + conn.remotePort;
      open_connections[key] = conn;
      conn.on('close', function() {
          delete open_connections[key];
      });
  });
  process.on('SIGINT', function() {
    console.log("\nGracefully shutting down from SIGINT (Ctrl-C)..." );

    // Don't take any new HTTP requests. This has a callback
    // but it doesn't finish until all of the open websocket
    // connections are forced to close, which we do next.
    server.close();

    // Ask all clients to gracefully send their last set
    // of changes and lock down.
    websocketio.emit("wrap-it-up", "The document server is going off-line. Apologies for the inconvenience.");

    // This doesn't seem to do anything.
    websocketio.close();

    // Forcibly close after a timeout.
    setTimeout(function() {
      for (var key in open_connections) {
        console.log("terminating ", key);
        open_connections[key].destroy();
      }
    }, 1000);
  })
});

