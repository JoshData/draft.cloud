var fs = require('fs');
var session = require('express-session')
var passport = require("passport");
var GitHubStrategy = require('passport-github2').Strategy;
var mustache = require("mustache");

var models = require("../draft-cloud-api/models.js");
var auth = require("../draft-cloud-api/auth.js");
var apiroutes = require("../draft-cloud-api/routes.js");

// Export a function that creates routes on the express app.

exports.create_routes = function(app, sessionStore, settings) {
  app.use(session({
    store: sessionStore,
    secret: settings.secret_key,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: settings.https }
  }))
  app.use(passport.initialize());
  app.use(passport.session());
  passport.serializeUser(function(user, done) {
    done(null, user.id);
  });
  passport.deserializeUser(function(id, done) {
    models.User.findById(id)
      .then(function(user) {
      done(null, user);
    });
  });

  // Github login.
  var github_login_path = "/auth/github";
  var github_callback_path = github_login_path + "/callback";
  passport.use(new GitHubStrategy({
      clientID: settings.GITHUB_CLIENT_ID,
      clientSecret: settings.GITHUB_CLIENT_SECRET,
      callbackURL: settings.url + github_callback_path
    },
    function(accessToken, refreshToken, profile, done) {
      models.UserExternalAccount
        .findOrCreate({ where: { provider: "github", identifier: profile.id }})
        .then(function(data) {
          var userextlogin = data[0];
          var isnew = data[1];
          if (!userextlogin.userId) { // better than isnew
            // Create new user account for this new login.
            models.User.create({
              name: profile.username
            }).then(function(user) {
              finish(user);
            });
          } else {
            // Look up user.
            models.User.find({ where: { id: userextlogin.userId }})
              .then(finish);
          }

          function finish(user) {
            // Update (or set for the first time).
            userextlogin.userId = user.id;
            userextlogin.tokens = { accessToken: accessToken, refreshToken: refreshToken };
            userextlogin.profile = profile;
            userextlogin.save();
            // Callback.
            done(null, user);
          }
      });
    }
  ));
  app.get(github_login_path,
    passport.authenticate('github', { scope: [ 'user:email' ] }));
  app.get(github_callback_path, 
    passport.authenticate('github', { failureRedirect: '/' }),
    function(req, res) {
      if (req.session.redirect_after_login) {
        res.redirect(req.session.redirect_after_login)
        delete req.session.redirect_after_login;
        return;
      }
      res.redirect('/');
    });

  // Start a new document.
  app.get("/new", function (req, res) {
    if (!req.user) {
      // Authenticate if not logged in.
      req.session.redirect_after_login = "/new";
      res.redirect(github_callback_path)
    } else {
      // Hey we're logged in! We can create a new document
      // and redirect.
      // TODO: What if user has no name?
      apiroutes.create_document(
        req.user,
        {
          // make the document public by default since it will get an unguessable address anyway
          anon_access_level: "READ"
        },
        function(doc) {
        res.redirect(req.user.name + "/" + doc.name)
      });
    }
  });

  // A document.
  var document_page = fs.readFileSync("templates/document.html", "utf8");
  app.get("/:owner/:document", function (req, res) {
    if (!req.user) {
      // Authenticate if not logged in.
      req.session.redirect_after_login = req.url;
      res.redirect(github_callback_path);
      return;
    }

    auth.get_document_authz(req, req.params.owner, req.params.document, function(user, owner, doc, level) {
      if (auth.min_access("READ", level) != "READ") {
        res.status(404).send('User or document not found or you do not have permission to see it.');
        return;
      }

      res.status(200).send(mustache.render(document_page, {
        "user": user,
        "owner": owner,
        "document": doc
      }))
    });

  });
}