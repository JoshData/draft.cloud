var express = require('express');

// Prep the database.
require("./draft-cloud-api/models.js")
  .initialize_database("sqlite://db.sqlite", function() {

  var app = express();

  // General expresss settings.
  app.use(require('helmet')())

  // Initialize the back-end API routes.
  require("./draft-cloud-api/routes.js")
    .create_routes(app);

  // Start listening.
  var port = 8000;
  var io = require('socket.io').listen(app.listen(port));

  // Initialize the back-end websocket handler, which must be
  // after we start listening.
  require("./draft-cloud-api/live.js")
    .init(io);

  // Initialize the front-end.
  app.use('', express.static(require('path').join(__dirname, 'public_html')))

});

