var fs = require('fs');
var express = require('express');

// Load local settings.
var settings = JSON.parse(fs.readFileSync("local/environment.json"))

// Prep the database.
require("./draft-cloud-api/models.js")
  .initialize_database("sqlite://db.sqlite", function() {

  var app = express();
  var sessionStore = require('express-session').MemoryStore;
    sessionStore = new sessionStore();

  // General expresss settings.
  app.use(require('helmet')())

  // Initialize the back-end API routes.
  require("./draft-cloud-api/routes.js")
    .create_routes(app, settings);

  // Initialize the front-end web routes.
  require("./draft-cloud-frontend/routes.js")
    .create_routes(app, sessionStore, settings);

  // Start listening.
  var io = require('socket.io').listen(app.listen(settings.port || 8000));

  // Initialize the back-end websocket handler, which must be
  // after we start listening.
  require("./draft-cloud-api/live.js")
    .init(io, sessionStore, settings);

  // Initialize the front-end.
  app.use('', express.static(require('path').join(__dirname, 'public_html')))

});

