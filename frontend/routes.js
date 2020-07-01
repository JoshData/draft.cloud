var fs = require('fs');
var session = require('express-session')
var passport = require("passport");
const credential = require('credential');
var bodyParser = require('body-parser')
const LocalStrategy = require("passport-local");
var GitHubStrategy = require('passport-github2').Strategy;
var mustache = require("mustache");
var moment = require("moment");
var async = require("async");

var models = require("../backend/models.js");
var auth = require("../backend/auth.js");
var apiroutes = require("../backend/routes.js");

// Export a function that adds authz middleware. All middleware
// must be added before routes it is used in, and we want
// passport's functionality to work for the backend routes too,
// so we separate it.
exports.add_middleware = function(app, sessionStore, settings) {
  if (!settings.secret_key) return; // can't do the logged in front-end without this, so skip
  app.use(session({
    store: sessionStore,
    secret: settings.secret_key,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: /^https:/.test(settings.url) }
  }))
  app.use(passport.initialize());
  app.use(passport.session());
  passport.serializeUser(function(user, done) {
    done(null, user.id);
  });
  passport.deserializeUser(function(id, done) {
    models.User.findByPk(id)
      .then(function(user) {
        done(null, user);
      });
  });
}

// Export a function that creates routes on the express app.

exports.create_routes = function(app, settings) {
  // Local username/password logins.
  passport.use(new LocalStrategy(
    function(username, password, done) {
      models.User.findOne({ where: { name: username }}).then(user => {
        if (!user) { return done(null, false); }
        credential().verify(user.key_hash, password, function(err, isValid) {
          if (err) return done(err);
          if (!isValid)
            return done(null, false);
          return done(null, user);
        });
      }).catch(done);
    }
  ));

  var github_login_path;
  var github_callback_path;
  if (settings.GITHUB_CLIENT_ID && settings.GITHUB_CLIENT_SECRET) {
    // Github login.
    
    github_login_path = "/auth/github";
    github_callback_path = github_login_path + "/callback"

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
              }).then(finish);
            } else {
              // Look up user.
              models.User.find({ where: { id: userextlogin.userId }})
                .then(finish);
            }

            function finish(user) {
              // Update (or set for the first time).
              userextlogin.userId = user.id;
              userextlogin.tokens = { accessToken: accessToken, refreshToken: refreshToken };
              userextlogin.profile = profile._json;
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
        if (req.session.redirect_after_login && req.user) {
          res.redirect(req.session.redirect_after_login)
          delete req.session.redirect_after_login;
          return;
        }
        res.redirect('/');
      });
  }

  var templates = { };
  function get_template(name) {
    if (!(name in templates) || settings.debug)
      templates[name] = fs.readFileSync("frontend/templates/" + name + ".html", "utf8");
    return templates[name];
  }

  // Homepage.
  app.get("/", function (req, res) {
    if (!req.user) {
      // Landing page.
      res.status(200).send(mustache.render(get_template("index"), {
        "settings": settings,
        "github_login_path": github_login_path,
        "user": req.user
      }));

    } else {
      // Does user have any documents?
      models.Document.findAll({
        where: { userId: req.user.id },
        include: [ { model: models.User } ]
      })
      .then(function(documents) {
        if (documents) {
          // Fetch preview and current revision of each document.
          async.each(documents, function(doc, cb) {
            doc.get_content(null, null, true, function(err, revision, content, path) {
              doc.currentContent = content;
              if (revision)
                doc.currentRevision = apiroutes.make_revision_response(revision, []);
              cb(null);
            });
          }, function(err) {
            // Format.
            documents = documents.map(apiroutes.make_document_json);

            // Format dates.
            documents.forEach(doc => {
              doc.createdRel = moment(doc.created).fromNow();
              if (doc.currentRevision)
                doc.currentRevision.createdRel = moment(doc.currentRevision.created).fromNow();
              doc.updatedAtISO = moment((doc.currentRevision && doc.currentRevision.created) || doc.created).format(); // ISO
            });

            // Make snippets.
            documents.forEach(doc => {
              if (doc.currentContent && doc.currentContent.ops) {
                var preview = "";
                doc.currentContent.ops.forEach(op => {
                  preview += op.insert;
                })
                doc.preview = preview.substr(0, 250);
              }
            });

            // Sort.
            documents.sort(function(b, a) { return a.updatedAtISO < b.updatedAtISO ? -1 : +(a.updatedAtISO > b.updatedAtISO) })

            // List documents page.
            res.status(200).send(mustache.render(get_template("home"), {
                "user": req.user,
                "documents": documents,
            }));
          });
        } else {
          // Go straight to starting a new document.
          res.redirect("/new");
        }
      });
    }
  });

  // Clear the session.
  app.post("/login",
    require('body-parser').urlencoded({ extended: true }),
    passport.authenticate('local', { failureRedirect: '/#login-error' }),
    function (req, res) {
      res.redirect("/")
  });

  // Clear the session.
  app.get("/logout", function (req, res) {
    req.logout();
    res.redirect("/")
  });

  // Create a new account.
  app.post("/new-account", bodyParser.urlencoded({ extended: true }), function (req, res) {
    if (!settings.allow_anonymous_user_creation) {
      res_send_plain(res, 403, 'You are not allowed to create a new user.');
      return;
    }

    // Validate the username.
    var validation = models.User.clean_user_dict({
      name: req.body.username
    });
    if (typeof validation != "object") {
      // Username was invalid.
      res_send_plain(res, 400, validation);
      return;
    }
    
    // Validate the password.
    if ((req.body.password || "").length < 4) {
      res_send_plain(res, 400, "Password is not long enough.");
      return;
    }

    // Hash the password.
    credential()
    .hash(req.body.password, function(err, key_hash) {
      if (err) {
        res_send_plain(res, 500, err);
        return;
      }

      // Create the user.
      models.User.create({
        name: req.body.username,
        key_hash: key_hash
      })
      .then(user => {
        // OK. Send them back to the homepage to login.
        res.redirect("/");
      })
      .catch(err => {
        res.redirect("/#new-account-error");
      })
    });
  });

  // Start a new document.
  app.get("/new", function (req, res) {
    if (!req.user) {
      if (!req.session) {
        // Sessions are not enabled.
        res.status(500).send('Sessions are not enabled.');
        return;
      }

      // Redirect to the homepage to login.
      req.session.redirect_after_login = "/new";
      res.redirect("/");
    } else {
      // Hey we're logged in! We can create a new document
      // and redirect.
      apiroutes.create_document(
        req.user,
        {
          // make the document public by default since it will get an unguessable address anyway
          public_access_level: "WRITE"
        },
        function(doc, err) {
          if (err) {
            console.log(err);
            res.status(500).send('An internal error occurred.');
            return;
          }
          res.redirect("/edit/" + req.user.name + "/" + doc.name)
        });
    }
  });

  // A document.
  app.get("/edit/:owner/:document", function (req, res) {
    if (!req.user && req.session /* if sessions are enabled */) {
      // Authenticate if not logged in.
      req.session.redirect_after_login = req.url;
      res.redirect("/");
      return;
    }

    // We get the owner and document names. Convert those to UUIDs because
    // auth.get_document_authz wants UUIDs. TODO: Once we have these records,
    // there is no need to do a second look-up in auth.get_document_authz.
    models.User.findOne({ where: { name: req.params.owner }})
    .then(function(owner) {
      models.Document.findOne({ where: { userId: owner ? owner.id : -1, name: req.params.document }})
      .then(function(document) {
        
        auth.get_document_authz(req, owner ? owner.uuid : "-invalid-", document ? document.uuid : "-invalid-", function(user, owner, doc, level) {
          if (auth.min_access("READ", level) != "READ") {
            res.status(404).send('User or document not found or you do not have permission to see it.');
            return;
          }

          res.status(200).send(mustache.render(get_template("document"), {
            "user": user,
            "owner": owner,
            "document": doc,
            "can_rename_owner": user.id == owner.id,
            "can_rename_document": level == "ADMIN",
            "valid_name_text": models.valid_name_text,
          }))
        });
      });      
    });      
  });
}
