const commandLineArgs = require('command-line-args');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');

// Parse settings from environment variables, then command line arguments, then a specified
// configuration file.

const optionDefinitions = [
  { name: 'bind_host', type: String, typeLabel: "localhost", description: "The network interface to listen on." },
  { name: 'port', type: Number, typeLabel: "8000", description: "The network port to listen on." },
  { name: 'url', type: String, typeLabel: "http://localhost:8000", description: "The public URL for the service." },
  { name: 'trust_proxy', type: String, typeLabel: "ip_address", description: "If behind a proxy, the IP address(es) or subnets of the proxy to trust for X-Forwarded-* headers. See https://expressjs.com/en/guide/behind-proxies.html." },
  { name: 'database', type: String, typeLabel: "sqlite://db.sqlite", description: "See https://sequelize.org/v5/manual/dialects.html for connection strings." },
  { name: 'database_logging', type: Boolean, description: "Log every database query." },
  { name: 'secret_key', type: String, typeLabel: "somerandomtext", description: "See https://www.npmjs.com/package/express-session#secret" },
  { name: 'allow_anonymous_user_creation', type: Boolean, description: "Allow user accounts to be created by unauthenticated users." },
  { name: 'GITHUB_CLIENT_ID', type: String, description: "GitHub OAuth client ID."},
  { name: 'GITHUB_CLIENT_SECRET', type: String, description: "GitHub OAuth client secret."},
  { name: 'settings_file', type: String, typeLabel: "file.env", description: "Read settings from configuration file." },
  { name: 'help', type: Boolean, description: "Show this help." }
];

var optionsMapUppercase = { };
optionDefinitions.forEach(opt => { optionsMapUppercase[opt.name.toUpperCase()] = opt });

function env_to_argv() {
  // Convert recognized environment variables to an array that looks like command-line arguments.
  var argv = [];
  Object.keys(process.env).forEach(key => {
    if (key in optionsMapUppercase) {
      argv.push("--" + optionsMapUppercase[key].name);
      if (optionsMapUppercase[key].type != Boolean)
        argv.push(process.env[key]);
    }
  });
  return argv;
}

function file_to_argv(fn) {
  // Convert a file containing KEY=value lines into an array that looks like command-line arguments.
  var argv = [];
  var lines = fs.readFileSync(fn, "utf8").split(/[\r\n]+/);
  lines.forEach(line => {
    var kv = /^(.*?)(=(.*))?$/.exec(line);
    if (!kv[1]) return;
    argv.push("--" + (kv[1] in optionsMapUppercase ? optionsMapUppercase[kv[1]].name : kv[1] ));
    if (kv[1] in optionsMapUppercase && optionsMapUppercase[kv[1]].type != Boolean)
      argv.push(kv[3]);
  });
  return argv;
}

var settings = {
  ...commandLineArgs(optionDefinitions, { argv: env_to_argv() }), // parse environment variables
  ...commandLineArgs(optionDefinitions) // parse command line
};
if (settings.settings_file)
  settings = { ...settings, ...commandLineArgs(optionDefinitions, { argv: file_to_argv(settings.settings_file) }) };

if (settings.help) {
  console.log(require('command-line-usage')([
  {
    header: 'Draft.cloud',
    content: 'A document collaboration server based on JOT: JSON Operational Transformation.'
  },
  {
    header: 'Options',
    optionList: optionDefinitions
  }
  ]));
  console.log("");
  console.log("All options can also be given in environment variables or in a settings file using these keys: "
    + optionDefinitions.map(opt => { return opt.name.toUpperCase() }).join(', '));
  process.exit(1);
}

// Fill in some defaults.
var bind = settings.bind_host || "localhost";
var port = settings.port || 8000;
if (!settings.url) // Default the 'url' to the same as the bind host and port.
  settings.url = "http://" + bind + ":" + port;

// Start the application.

// First initialize the database.
require("./backend/models.js")
  .initialize_database(settings, function() {

  // Start the HTTP server.
  var app = express();
  var sessionStore = require('express-session').MemoryStore;
    sessionStore = new sessionStore();

  // General expresss settings.
  if (settings.trust_proxy) app.set('trust proxy', settings.trust_proxy); // express won't set secure cookies if it can't see it's running behind https
  app.use(require('helmet')())
  app.use(require('helmet-csp')({
    directives: {
      defaultSrc: ["'self'", (settings.url + (/^https:/.test(settings.url) ? ":443" : "")).replace(/https?:/, 'ws:')],
      styleSrc: ["'self'", "'unsafe-inline'" /* Quill clipboard paste breaks without it */],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", 'data:']
    }
  }))

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

