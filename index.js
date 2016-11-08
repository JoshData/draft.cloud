var express = require('express');

var app = express();

// General expresss settings.
app.use(require('helmet')())

// Initialize the back-end.
require("./draft-cloud-api/routes.js")
	.create_routes(app);
require("./draft-cloud-api/models.js")
	.initialize_database("sqlite://db.sqlite")

// Initialize the front-end.
app.use('', express.static(require('path').join(__dirname, 'public_html')))

// Start the application server.
app.listen(8000, function () {
  console.log('Example app listening on port 8000!')
})
