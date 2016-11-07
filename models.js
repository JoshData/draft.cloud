const Sequelize = require('sequelize');
const uuid = require('uuid');
const argon2 = require('argon2');
const zlib = require('zlib');

var db;

exports.initialize_database = function(connection_uri) {
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
  exports.UserApiKey = db.define('owner_api_key',
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
          fields: ['key_hash']
        },
      ],
      freezeTableName: true, // Model tableName will be the same as the model name
      classMethods: {
        createApiKey: function(user, cb) {
          // Create a new API key. The callback is called with the UserApiKey
          // instance and the API key itself as arguments. We forget the API
          // key immediately and only store a hash. The caller should increase
          // the access level and/or set a comment.
          var key = uuid.v4();
          argon2.generateSalt().then(function(salt) {
            argon2.hash(key, salt).then(function(key_hash) {
              exports.UserApiKey.create({
                userId: user.id,
                access_level: "",
                resource_acess_levels: { },
                key_hash: key_hash
              }).then(function(obj) {
                // From the user's point of view, the API key is an opaque
                // string that contains both the key's UUID and the key itself.
                // Having the UUID be in it allows us to quickly find the key
                // on an indexed column.
                var api_key = obj.uuid + ":" + key;
                zlib.deflateRaw(api_key, (err, buffer) => {
                  api_key = buffer.toString('base64');
                  cb(obj, api_key);
                });
              })
            });
          });
        },

        validateApiKey: function(api_key, cb) {
          // Validates an API key and executes the callback with the
          // User and UserApiKey object instances, or with undefineds
          // if the key did not validate.

          // Base64-decode the API key to get a Buffer.
          try {
            buffer = new Buffer(api_key, 'base64');
          } catch (e) {
            cb();
            return;
          }

          // Inflate it.
          zlib.inflateRaw(
            buffer,
            (err, buffer) => {
              if (err) {
                cb();
                return;
              }

              // Turn it back to a string. TODO: Error handling?
              api_key = buffer.toString('ascii');

              // Split on a colon.
              key_parts = api_key.split(/:/);
              if (key_parts.length != 2) {
                cb();
                return;
              }

              // Fetch the object.
              exports.UserApiKey.findOne({
                where: {
                  uuid: key_parts[0]
                }})
              .then(function(userapikey) {
                if (!userapikey) {
                  cb();
                  return;
                }

                // Verify the key.
                argon2.verify(userapikey.key_hash, key_parts[1]).then(match => {
                  if (match) {
                    // TODO: Merge this with the previous query.
                    exports.User.findOne({
                      where: {
                        id: userapikey.userId
                      }})
                    .then(function(user) {
                      cb(user, userapikey);
                    });
                  }
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

      // The access level granted to all (including anonymous) users.
      anon_access_level: {
        type: Sequelize.STRING(16),
        defaultValue: "READ"
      },

      // User-provided arbitrary metadata stored with the document.
      userdata: {
        type: Sequelize.JSON
      },
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
  db.sync().then(function() {
    // On first use create a user and dump its API key.
    exports.User.count().then(function(count) {
      if (count == 0) {
        exports.User.create({
          name: 'josh'
        }).then(function(user) {
          exports.UserApiKey.createApiKey(user, function(obj, api_key) {
            // Give the key WRITE access.
            obj.set("access_level", "WRITE");
            obj.save();
            exports.UserApiKey.validateApiKey(api_key, function(user, key) {
              console.log(user.name + " your key is " + api_key)
            })
          });
        });
      }
    });

  });

}