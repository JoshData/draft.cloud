var express = require('express');

var app = express();

require("./routes.js").create_routes(app);
require("./models.js").initialize_database("sqlite://db.sqlite")

// APP SERVER

app.listen(8000, function () {
  console.log('Example app listening on port 8000!')
})
