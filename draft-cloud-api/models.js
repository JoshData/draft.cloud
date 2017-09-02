const Sequelize = require('sequelize');
const credential = require('credential');

const auth = require('./auth.js');

var db;

var valid_name_regex = /^[A-Za-z0-9_-]{5,64}$/;
var valid_name_text = "Names may only contain the characters A-Z, a-z, 0-9, underscore, and hyphen and must be between 5 and 64 characters inclusive.";

exports.initialize_database = function(connection_uri, ready) {
  exports.db = new Sequelize(connection_uri);

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

  // Synchronize models to database tables.
  exports.db.sync().then(ready);

}