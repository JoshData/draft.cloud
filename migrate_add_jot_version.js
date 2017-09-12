var fs = require("fs");
var async = require("async");

var models = require("./draft-cloud-api/models.js");
var jot = require("jot");

var settings = JSON.parse(fs.readFileSync("local/environment.json"))

models.initialize_database(settings, function() {
	models.Revision.findAll().then(function(revs) {
		async.eachLimit(
			revs,
			10,
			function(rev, cb) {
				if ("_ver" in rev.op) { cb(); return; }
				var before = jot.opFromJSON(rev.op, 1);
				rev.op["_ver"] = 1;
				rev.op = rev.op; // necessary so that Sequelize knows it needs to save it
				var after = jot.opFromJSON(rev.op);
				if (jot.cmp(before, after) != 0) {
					cb("didn't match");
					return;
				}
				console.log('saving', rev.id, rev.op);
				rev.save({ fields: ['op'] }).then(function() { cb(); }).error(cb);
			},
			function(err) {
				console.log(err);
			});
	});
});
