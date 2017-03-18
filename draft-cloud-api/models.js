const Sequelize = require('sequelize');
const credential = require('credential');

const auth = require('./auth.js');

var db;

var valid_name_regex = /^[A-Za-z0-9_-]{5,64}$/;
var valid_name_text = "Names may only contain the characters A-Z, a-z, 0-9, underscore, and hyphen and must be between 5 and 64 characters inclusive.";

exports.initialize_database = function(connection_uri, ready) {
  db = new Sequelize(connection_uri);

  // CREATE MODELS

  // USERs.
  exports.User = db.define('user',
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

  // API KEYs.
  exports.UserApiKey = db.define('user_api_key',
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
      freezeTableName: true, // Model tableName will be the same as the model name
      classMethods: {
        createApiKey: function(user, password_hash_work, cb) {
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

                // From the user's point of view, the API key is an opaque
                // string that contains both the key's UUID and the key itself.
                // Having the UUID be in it allows us to quickly find the key
                // on an indexed column. Base64-encoding the UUID is shorter
                // than putting the UUID in in the usual UUID format.
                var api_key =
                  new Buffer(require('node-uuid').parse(obj.uuid)).toString('base64')
                  + "." + key
                  + ".0"; // end with a key schema version

                // Send the UserApiKey instance and the clear-text API key to the callback.
                cb(obj, api_key);
              });
            });          
          });
        },

        validateApiKey: function(api_key, cb) {
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

          // Decode the Base64 UUID of the key, which is the first component.
          try {
            uuid = require('uuid').unparse(new Buffer(uuid, 'base64'));
          } catch (e) {
            cb();
            return;             
          }

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
      }
    });
  exports.UserApiKey.belongsTo(exports.User);

  // DOCUMENTs.
  exports.Document = db.define('document',
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
  exports.Revision = db.define('revision',
    {
      // A global identifier for this Revision.
      uuid: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4
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
      },

      // The document content as of this Revision, if has_cached_document is true.
      cached_document: {
        type: Sequelize.JSON,
        defaultValue: null
      },

      // A boolean indicating whether cached_document is filled in with a value.
      has_cached_document: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },
    }, {
      freezeTableName: true // Model tableName will be the same as the model name
    });
  exports.Revision.belongsTo(exports.User);
  exports.Revision.belongsTo(exports.Document);

  // Synchronize models to database tables.
  db.sync().then(ready);

}