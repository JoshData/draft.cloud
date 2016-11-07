var Sequelize = require('sequelize');

var db;

exports.initialize_database = function(connection_uri) {
  db = new Sequelize(connection_uri);

  // CREATE MODELS

  exports.Owner = db.define('owner',
    {
      name: {
        type: Sequelize.STRING
      },
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

  exports.OwnerApiKey = db.define('owner_api_key',
    {
      key: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4
      },
      access_level: {
        type: Sequelize.STRING(16)
      }
    }, {
      indexes: [
        {
          unique: true,
          fields: ['key']
        },
      ],
      freezeTableName: true // Model tableName will be the same as the model name
    });
  exports.OwnerApiKey.belongsTo(exports.Owner);

  exports.Document = db.define('document',
    {
      name: {
        type: Sequelize.STRING
      },
      uuid: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4
      },
      default_access_level: {
        type: Sequelize.STRING(16),
        defaultValue: "READ"
      },
      meta: {
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
          fields: ['ownerId', 'name']
        },
      ],
      freezeTableName: true // Model tableName will be the same as the model name
    });
  exports.Document.belongsTo(exports.Owner);

  exports.Revision = db.define('revision',
    {
      uuid: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4
      },
      op: {
        type: Sequelize.JSON
      },
      cached_document: {
        type: Sequelize.JSON,
        defaultValue: null
      },
      has_cached_document: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },
    }, {
      freezeTableName: true // Model tableName will be the same as the model name
    });
  exports.Revision.belongsTo(exports.Owner);
  exports.Revision.belongsTo(exports.Document);

  // Synchronize models to database tables.
  db.sync().then(function() {
    // On first use create a user.
    function show_user_api_key() {
      exports.OwnerApiKey.findOne({
        include: [{
          model: exports.Owner,
          where: {
            ownerId: Sequelize.col('owner.id'),
            name: 'josh' }
        }]
      }).then(function(api_key) {
        console.log("debug api key:", api_key.key)
      });
    }
    exports.Owner.count().then(function(count) {
      if (count == 0) {
        exports.Owner.create({
            name: 'josh'
        }).then(function(owner) {
          exports.OwnerApiKey.create({
            ownerId: owner.id,
            access_level: "WRITE"
          }).then(function(key) {
            show_user_api_key();
          })
        });
      } else {
        // User should already exist.
        show_user_api_key();
      }
    });

  });


}