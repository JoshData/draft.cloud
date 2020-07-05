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
var merge = require("../backend/merge.js");
var committer = require("../backend/committer.js");
var jot = require("jot");

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

  function res_send_plain(res, status_code, message) {
    res
      .status(status_code)
      .set('Content-Type', 'text/plain')
      .send(message)
      .end();
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
      // The user is not logged in. Show a landing page.
      res.status(200).send(mustache.render(get_template("index"), {
        "settings": settings,
        "github_login_path": github_login_path,
        "req": req
      }));
      return;

    }

    // Show the user's home page.

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
  });

  // Handle username/password login.
  app.post("/login",
    require('body-parser').urlencoded({ extended: true }),
    passport.authenticate('local', { failureRedirect: '/#login-error' }),
    function (req, res) {
      res.redirect("/")
  });

  // Clear the session.
  // TODO: Make this a POST for CSRF protection.
  app.get("/logout", function (req, res) {
    if (req.session)
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
        // Log them in.
        req.login(user, function (err) {
          res.redirect("/");
        })        
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
      return;
    }

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
  });

  function document_auth(req, res, owner_name, document_name, cb) {
    // We get the owner and document names. Convert those to UUIDs because
    // auth.get_document_authz wants UUIDs. TODO: Once we have these records,
    // there is no need to do a second look-up in auth.get_document_authz.
    models.User.findOne({ where: { name: owner_name }})
    .then(function(owner) {
      models.Document.findOne({ where: { userId: owner ? owner.id : -1, name: document_name }})
      .then(function(document) {
        auth.get_document_authz(req, owner ? owner.uuid : "-invalid-", document ? document.uuid : "-invalid-", function(user, owner, doc, level) {
          if (auth.min_access("READ", level) != "READ") {
            res.status(404).send('User or document not found or you do not have permission to see it.');
            return;
          }
          cb(user, owner, doc, level);
        });
      });
    });    
  }
  function document_route(req, res, cb) {
    document_auth(req, res, req.params.owner, req.params.document, cb);
  }

  // A document.
  app.get("/edit/:owner/:document", function (req, res) {
    if (!req.user && req.session /* if sessions are enabled */) {
      // Authenticate if not logged in.
      req.session.redirect_after_login = req.url;
      res.redirect("/");
      return;
    }

    document_route(req, res, function(user, owner, doc, level) {
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

  function merge_route(req, res, cb) {
    if (!req.user && req.session /* if sessions are enabled */) {
      // Authenticate if not logged in.
      req.session.redirect_after_login = req.url;
      res.redirect("/");
      return;
    }

    // Get the source and target documents. READ access is needed on each.
    document_route(req, res, function(user, target_owner, target_doc, target_level) {
      var other_user_doc = (req.query.from || "").split(/\//);
      document_auth(req, res, other_user_doc[0], other_user_doc[1], function(_, source_owner, source_doc, source_level) {
        // Get the most recent commit of each document. The source document can specify
        // a revision UUID in the revision query string argument. On post, get the revisions
        // from the form data.
        var base_revision = null; // get latest revision
        var source_revision = req.params.revision || null; // get specified revision or latest
        if (req.body) {
          // In a post request, get from the post.
          base_revision = req.body.base_revision;
          source_revision = req.body.source_revision;
        }
        models.Revision.from_uuid(target_doc, base_revision, function(base_revision) {
          models.Revision.from_uuid(source_doc, source_revision, function(source_revision) {
            if (!base_revision || !source_revision) {
              // Impossible on GET but on POST we validate the revision IDs.
              res.status(400).send("Invalid revision IDs.");
              return;
            }

            // Compute the merge.
            merge.compute_merge_operation(target_doc, base_revision, source_doc, source_revision, function(err, op, dual_op) {
              if (err) {
                res.status(500).send("Error performing merge: " + err);
                return;
              }
              cb(user,
                target_owner, target_doc, target_level, base_revision,
                source_owner, source_doc, source_level, source_revision,
                op, dual_op);
            });
          });
        });
      });
    });
  }


  // Merge documents - preview.
  app.get("/merge/:owner/:document", function (req, res) {
    // The user must have READ access to both the source document and the
    // target document.
    // TODO: If the user is the owner of the source or target document (and
    // in the former case must have had READ access to the target at some point)
    //  but doesn't have access to the other one (anymore), a nicer error
    // message might be nice.
    merge_route(req, res, function(user,
              target_owner, target_doc, target_level, base_revision,
              source_owner, source_doc, source_level, source_revision,
              op) {

      // Get the document content of the target document.
      target_doc.get_content(null, base_revision, true, function(err, revision, content_before, path) {
        // Apply the changes.
        var content_after = op.apply(content_before);

        // Convert the document to HTML, before and after the change.
        var to_html = (document) => {
          const converter = require('quill-delta-to-html').QuillDeltaToHtmlConverter;
          return new converter(document.ops, {}).convert();
        }
        var html_before = to_html(content_before);
        var html_after = to_html(content_after);
        var html_diff = require('node-htmldiff')(html_before, html_after);

        // If the user doesn't have permission to save the merge, then does anyone?
        auth.get_users_with_access_to_document(source_doc, "READ", function(source_readers) {
          auth.get_users_with_access_to_document(target_doc, "WRITE", function(target_writers) {
            res.status(200).send(mustache.render(get_template("merge"), {
              "user": user,
              "target_owner": target_owner,
              "target_document": target_doc,
              "base_revision": base_revision,
              "source_owner": source_owner,
              "source_document": source_doc,
              "source_revision": source_revision,
              "has_merge": !op.isNoOp(),
              "html_diff": html_diff,
              "can_merge": auth.min_access("WRITE", target_level) == "WRITE",
              "who_can_merge": target_writers.filter(user => source_doc.public_access_level == "READ" || source_readers.includes(user)),
              "is_source_admin": auth.min_access("ADMIN", source_level) == "ADMIN",
            }));              
          });
        })
      });
    });
  });

  // Merge documents - commit.
  app.post("/merge/:owner/:document",
    require('body-parser').urlencoded({ extended: true }),
    function (req, res) {
    merge_route(req, res, function(user,
              target_owner, target_doc, target_level, base_revision,
              source_owner, source_doc, source_level, source_revision,
              op, dual_op) {

      if (auth.min_access("WRITE", target_level) != "WRITE") {
        res.status(401).send("Permission denied.");
        return;
      }

      // Commit the change.
      var userdata = { };
      committer.save_revision({
        user,
        doc: target_doc,
        base_revision,
        op,
        userdata,
        merges_revision: source_revision,
        merges_op: dual_op
        },
        function(err, rev) {
          if (err) {
            res.status(500).send("Error performing merge: " + err);
            return;
          }
          res.redirect("/edit/" + target_owner.name + "/" + target_doc.name);
      });
    });
  });  
}
