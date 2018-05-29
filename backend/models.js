const fs = require('fs');
const Sequelize = require('sequelize');
const credential = require('credential');

const auth = require('./auth.js');

var json_ptr = require('json-ptr');
var jot = require("jot");

var db;

var valid_name_regex = /^[A-Za-z0-9_-]{5,64}$/;
var valid_name_text = "Names may only contain the characters A-Z, a-z, 0-9, underscore, and hyphen and must be between 5 and 64 characters inclusive.";

exports.initialize_database = function(settings, ready) {
  // Replace the ssl.ca field with file contents.
  if (settings.database_connection_options && settings.database_connection_options.ssl && settings.database_connection_options.ssl.ca)
    settings.database_connection_options.ssl.ca = fs.readFileSync(settings.database_connection_options.ssl.ca);

  exports.db = new Sequelize(
    settings.database || "sqlite://db.sqlite",
    {
      dialectOptions: settings.database_connection_options,
      operatorsAliases: false,
      logging: settings.database_logging ? console.log : null
    }
  );

  // CREATE MODELS

  // USERs.
  exports.User = exports.db.define('user',
    {
      // The 'name' is the text that appears in URLs.
      name: {
        type: Sequelize.STRING
      },

      // The UUID persistently identifies this user across name changes.
      uuid: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4
      },

      // A JSON object containing user profile information.
      profile: {
        type: Sequelize.JSON
      }
    }, {
      paranoid: true, // rows are never deleted, just marked as deleted
      indexes: [
        {
          unique: true,
          fields: ['name']
        },
        {
          unique: true,
          fields: ['uuid']
        },
      ],
      freezeTableName: true // Model tableName will be the same as the model name
    });
  exports.User.belongsTo(exports.User, {as: 'owner'});

  exports.User.clean_user_dict = function(user) {
    // Validate that user-supplied fields are valid.

    // Did we get an object?
    if (!user || typeof user != "object")
      return "Must supply an object.";

    // Name must be at least a subset of what express routes will
    // recognize as a parameter.
    if (typeof user.name != "undefined") {
      if (typeof user.name != "string" || !valid_name_regex.test(user.name))
        return "Invalid user name. " + valid_name_text;
    }

    // Profile, if specified, must be an object.
    if ((typeof user.profile != "undefined" && typeof user.profile != "object") || user.profile === null)
      return "Invalid profile object."

    // Return cleaned object.
    return user;
  }

  // API KEYs.
  exports.UserApiKey = exports.db.define('user_api_key',
    {
      // A UUID to identify the API key. It is for identification only
      // and is not secret.
      uuid: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4
      },

      // A comment for this API key, like what it is used for or what machine
      // it has been stored on.
      comment: {
        type: Sequelize.TEXT
      },

      // The SHA1 hash of the API key. We don't store the actual API
      // key, just as we wouldn't store a password plainly.
      key_hash: {
        type: Sequelize.TEXT,
      },

      // The (maximum) access level granted to all resources accessible to the
      // owner of this key, unless a resource is listed in resource_access_levels.
      access_level: {
        type: Sequelize.STRING(16)
      },

      // A JSON object where the keys are UUIDs of resources and the values
      // are access levels given to those resources. The access level here
      // has precedence over access_level.
      resource_acess_levels: {
        type: Sequelize.JSON
      }
    }, {
      indexes: [
        {
          unique: true,
          fields: ['uuid']
        },
      ],
      freezeTableName: true // Model tableName will be the same as the model name
    });
  exports.UserApiKey.belongsTo(exports.User);
  exports.UserApiKey.createApiKey = function(user, password_hash_work, cb) {
          // Create a new API key. The callback is called with the UserApiKey
          // instance and the API key itself as arguments. We forget the API
          // key immediately and only store a hash. The caller should increase
          // the access level and/or set a comment.

          // Generate the random key and convert to Base64.
          require('crypto').randomBytes(24, function(err, buffer) {
            if (err) { throw err; }
            var key = buffer.toString('base64');

            // Hash it...
            credential({ work: password_hash_work || 1 })
            .hash(key, function(err, key_hash) {
              if (err) { throw err; }

              // Store the hash in the database...
              exports.UserApiKey.create({
                userId: user.id,
                access_level: "NONE",
                resource_acess_levels: { },
                key_hash: key_hash
              }).then(function(obj) {
                // Send the UserApiKey instance and the clear-text API key to the callback.
                var api_key = obj.uuid + "." + key + ".0"; // end with a key schema version
                cb(obj, api_key);
              });
            });          
          });
        };

  exports.UserApiKey.validateApiKey = function(api_key, cb) {
          // Validates an API key and executes the callback with the
          // User and UserApiKey object instances, or with undefineds
          // if the key did not validate.

          // Split on a dot, verify schema version at the end.
          key_parts = api_key.split(/\./);
          if (key_parts.length != 3 || key_parts[2] != "0") {
            cb();
            return;
          }

          var uuid = key_parts[0];
          var key = key_parts[1];

          // Look up the key record using the UUID.
          exports.UserApiKey.findOne({
            where: {
              uuid: uuid,
            }})
          .then(function(userapikey) {
            if (!userapikey) {
              cb();
              return;
            }

            // Verify the key itself.
            credential().verify(userapikey.key_hash, key, function(err, isValid) {
              if (err) { throw err; }
              if (!isValid) {
                cb();
                return;
              }

              // TODO: Merge this database query with the previous query.
              exports.User.findOne({
                where: {
                  id: userapikey.userId
                }})
              .then(function(user) {
                cb(user, userapikey);
              });
            });
          });
        }

  // SOCIAL LOGINS.
  exports.UserExternalAccount = exports.db.define('user_external_account',
    {
      // The name of the account provider.
      provider: {
        type: Sequelize.STRING(64)
      },

      // The user's identifier provided by the provider.
      identifier: {
        type: Sequelize.STRING(128)
      },

      // Access tokens provided by the provider.
      tokens: {
        type: Sequelize.JSON
      },

      // Profile information provided by the provider.
      profile: {
        type: Sequelize.JSON
      }
    }, {
      indexes: [
        {
          unique: true,
          fields: ['provider', 'identifier']
        },
      ],
      freezeTableName: true // Model tableName will be the same as the model name
    });
  exports.UserExternalAccount.belongsTo(exports.User);

  // DOCUMENTs.
  exports.Document = exports.db.define('document',
    {
      // The 'name' is the text that appears in URLs.
      name: {
        type: Sequelize.STRING
      },

      // The UUID identifies this Document persistently across name changes.
      uuid: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4
      },

      // The access level granted to all (including anonymous) users
      // (default no access to anyone but the owner).
      anon_access_level: {
        type: Sequelize.STRING(16),
        defaultValue: ""
      },

      // User-provided arbitrary metadata stored with the document.
      userdata: {
        type: Sequelize.JSON
      }
    }, {
      paranoid: true, // rows are never deleted, just marked as deleted
      indexes: [
        {
          unique: true,
          fields: ['uuid']
        },
        {
          unique: true,
          fields: ['userId', 'name']
        },
      ],
      freezeTableName: true // Model tableName will be the same as the model name
    });
  exports.Document.belongsTo(exports.User);

  exports.Document.clean_document_dict = function(doc) {
    // Validate that user-supplied fields are valid.

    // Did we get an object?
    if (!doc || typeof doc != "object")
      return "Must supply a document object.";

    // Name must be at least a subset of what express routes will
    // recognize as a parameter.
    if (typeof doc.name != "undefined") {
      if (typeof doc.name != "string" || !valid_name_regex.test(doc.name))
        return "Invalid document name. " + valid_name_text;
    }

    // Acess level must be valid.
    if (typeof doc.anon_access_level != "undefined") {
      if (!auth.is_access_level(doc.anon_access_level))
        return "Invalid access level.";

      // Document cannot be world-ADMINable.
      if (doc.anon_access_level == "ADMIN")
        return "Invalid document access level.";
    }

    // Userdata, if specified, must be an object.
    if ((typeof doc.userdata != "undefined" && typeof doc.userdata != "object") || doc.userdata === null)
      return "Invalid document userdata."

    // Return cleaned object.
    return doc;
  }

  exports.Document.prototype.get_content = function(pointer, at_revision, save_cached_content, cb) {
    // Get the content of a document (or part of a document) at a particular revision.
    //
    // pointer is null or a string containing a JSON Pointer indicating the part of
    // the document to retrieve.
    //
    // at_revision is null to get the most recent document content, a Revision instance,
    // a revision UUID, or "singularity", which represents the state of the document
    // prior to the first Revision.
    //
    // Calls cb(error) or cb(null, revision, content, path), where revision is null
    // representing the "singularity" or a Revision instance, content is the document
    // content, and path is a data structure similar to the pointer that is used to
    // create JOT operations at that path --- unlike pointer, it distinguishes Array and
    // Object accesses.

    var doc = this;

    if (at_revision == "singularity") {
      // This is a special value that signals the state of the document
      // prior to the first Revision. The document is always a null value
      // at that state.
      if (pointer)
        cb('Document path ' + pointer + ' cannot exist before the document is started.');
      else
        cb(null, null, null, []);
      return;
    }

    if (typeof at_revision === "string") {
      // If given a Revision UUID, look it up in the database.
      exports.Revision.from_uuid(doc, at_revision, function(revision) {
        if (!revision)
            cb('Invalid revision: ' + at_revision);
        else
          doc.get_content(pointer, revision, save_cached_content, cb);
      });
      return;
    }

    // Find the most recent CachedContent, but no later
    // than at_revision (if at_revision is not null).
    var where = { documentId: doc.id };
    if (at_revision)
      where['revisionId'] = { [Sequelize.Op.lte]: at_revision.id };
    exports.CachedContent.findOne({
      where: where,
      order: [["revisionId", "DESC"]],
      include: [{
        model: exports.Revision
      }]
    })
    .then(function(cache_hit) {
      // Load all subsequent revisions. Add to the id filter to only get
      // revisions after the cache hit's revision. The cache_hit may be null
      // if there is no available cached content --- in which case
      // we load all revisions from the beginning.
      var where = {
        documentId: doc.id,
        committed: true
      };
      if (at_revision || cache_hit)
        where["id"] = { };
      if (at_revision)
        where['id'][Sequelize.Op.lte] = at_revision.id;
      if (cache_hit)
        where['id'][Sequelize.Op.gt] = cache_hit.revisionId;
      exports.Revision.findAll({
        where: where,
        order: [["id", "ASC"]]
      })
      .then(function(revs) {
        // Documents always start with a null value at the start of the revision history.
        var current_revision = null;
        var content = null;

        // Start with the peg revision, assuming there was one.
        if (cache_hit) {
          content = cache_hit.document_content;
          current_revision = cache_hit.revision;
        }

        // Apply all later revisions' operations (if any).
        for (var i = 0; i < revs.length; i++) {
          var op = jot.opFromJSON(revs[i].op);
          content = op.apply(content);
          current_revision = revs[i];
        }

        // We now have the latest content....

        // If the most recent revision doesn't have cached content,
        // store it so we don't have to do all this work again next time.
        if (revs.length > 0 && save_cached_content) {
          exports.CachedContent.create({
                documentId: doc.id,
                revisionId: current_revision.id,
                document_content: content
              }).then(function(user) {
                // we're not waiting for this to finish
              });
        }

        // Execute the JSON Pointer given in the URL. We could use
        // json_ptr.get(content, pointer). But the PUT function needs
        // to know whether the pointer passes through arrays or objects
        // in order to create the correct JOT operations that represent
        // the change. So we have to step through each part and record
        // whether we are passing through an Object or Array.
        var x = parse_json_pointer_path_with_content(pointer, content);
        if (!x)
          cb('Document path ' + pointer + ' not found.');
        op_path = x[0];
        content = x[1];

        // Callback.
        cb(null, current_revision, content, op_path);
      })
      .catch(function(err) {
        cb("There is an error with the document.");
        console.log(err);
      });
    })
    .catch(function(err) {
      cb("There is an error with the document cache.");
      console.log(err);
    });
  }

  function parse_json_pointer_path_with_content(pointer, content) {
    // The path is a JSON Pointer which we parse with json-ptr.
    // Unfortunately the path components are all strings, but
    // we need to distinguish array index accessses from object
    // property accesses. We'll distinguish by turning the pointer
    // into an array of strings (for objects) and integers (for
    // arrays). We can only know the difference by looking at
    // an actual document. So we'll step through the path and
    // see if we are passing through arrays or objects.

    var op_path = [ ];
    if (!pointer)
      return [op_path, content];

    for (let item of json_ptr.decodePointer(pointer)) {
      if (Array.isArray(content))
        // This item on the path is an array index. Turn the item
        // into a number.
        op_path.push(parseInt(item));
      else
        // This item is an Object key, so we keep it as a string.
        op_path.push(item)

      // Use json-ptr to process just this part of the path. This way
      // we get its error handling.
      content = json_ptr.get(content, json_ptr.encodePointer([item]));
      if (typeof content == "undefined")
        return null;
    }

    return [op_path, content];
  }


  // REVISIONs.
  exports.Revision = exports.db.define('revision',
    {
      // A global identifier for this Revision.
      uuid: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4
      },

      // Whether this operation has been committed yet. An uncommitted
      // Revision has a baseRevision that it still needs to be rebased
      // against. Uncommitted revisions are not exposed to the user.
      // They are committed in order of their primary key 'id'.
      committed: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },

      // Whether this operation has been committed yet. An uncommitted
      // Revision has a baseRevision that it still needs to be rebased
      // against. Uncommitted revisions are not exposed to the user.
      // They are committed in order of their primary key 'id'.
      error: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },

      // For an uncommitted Revision, the JSON Pointer to a sub-part of
      // the document that is being modified.
      doc_pointer: {
        type: Sequelize.STRING
      },

      // A JOT operation giving the change to the document made in this Revision.
      op: {
        type: Sequelize.JSON
      },

      // A comment about the revision entered by the revision's author.
      comment: {
        type: Sequelize.TEXT
      },

      // User-provided arbitrary metadata stored with the revision.
      userdata: {
        type: Sequelize.JSON
      }
    }, {
      freezeTableName: true // Model tableName will be the same as the model name
    });
  exports.Revision.belongsTo(exports.User);
  exports.Revision.belongsTo(exports.Document);
  exports.Revision.belongsTo(exports.Revision, {as: 'baseRevision'});

  exports.Revision.from_uuid = function(doc, uuid, cb) {
    // Gets a Revision instance from a revision UUID. If uuid is...
    //   "singularity", then the string "singularity" is returned
    //   "", then the most recent revision ("singularity" or a Revision instance)
    //   a revision UUID, then that one
    //   not valid, then null
    // ... is passed to the callback.

    // If "singularity" is passed, pass it through as a specicial revision.
    if (uuid == "singularity")
      cb("singularity")

    // Find the named revision.
    else if (uuid)
      exports.Revision.findOne({
        where: { documentId: doc.id, uuid: uuid },
        include: [{ model: exports.User }]
      })
      .then(function(revision) {
        if (!revision)
          cb(null);
        else
          cb(revision);
      })
      .catch(function(err) {
        console.log(err);
        cb(null);
      });

    // Get the most recent revision. If there are no revisions yet,
    // pass forward the spcial ID "singularity".
    else
      exports.Revision.findOne({
        where: { documentId: doc.id },
        order: [["id", "DESC"]] // most recent
      })
      .then(function(revision) {
        if (!revision)
          cb("singularity");
        else
          cb(revision);
      });
  }

  // CACHED DOCUMENT CONTENT.
  exports.CachedContent = exports.db.define('cachedcontent',
    {
      // The document content as of this Revision
      document_content: {
        type: Sequelize.JSON
      }
    }, {
      freezeTableName: true // Model tableName will be the same as the model name
    });
  exports.CachedContent.belongsTo(exports.Document);
  exports.CachedContent.belongsTo(exports.Revision);

  // DOCUMENT PERMISSIONs (for non-owners).
  exports.DocumentPermission = exports.db.define('documentpermission',
    {
      // The access level granted to this user for this document.
      access_level: {
        type: Sequelize.STRING(16),
        defaultValue: ""
      },

      // Some additional information.
      userdata: {
        type: Sequelize.JSON
      }
    }, {
      paranoid: true, // rows are never deleted, just marked as deleted
      freezeTableName: true // Model tableName will be the same as the model name
    });
  exports.DocumentPermission.belongsTo(exports.User);
  exports.DocumentPermission.belongsTo(exports.Document);

  // Synchronize models to database tables.
  exports.db.sync().then(ready);

}
