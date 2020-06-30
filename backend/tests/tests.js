var test = require("./test_harness.js");

test.test("General Tests", {}, function(test) {
  // There is no route at /.
  test.apicall(
    "GET", "/", null, {},
    404, "text/html",
    function(body, headers, test) {
    test.match(body, '<pre>Cannot GET /</pre>', '404 message in body');
  });
});

// TODO: Check when settings.allow_anonymous_user_creation == false.

test.test("User Tests", {}, function(test) {
  // Create a user
  test.apicall(
    "POST", "/api/v1/users", null, {},
    200, "application/json",
    function(body, headers, test) {
    test.ok(body.id, 'user has id');
    test.ok(body.name, 'user has name');
    test.ok(headers['x-api-key'], 'response has api key header')
  })
  .then((res) => {
    var user = res.body;
    var api_key = res.headers['x-api-key'];

    // From now on, always pass an API key.
    var apicall_no_api_key = test.apicall;
    test.apicall = function(method, path, body, headers, expected_response_code, expected_response_type, check_response) {
      headers['Authorization'] = api_key;
      return apicall_no_api_key(method, path, body, headers, expected_response_code, expected_response_type, check_response);
    };

    // Check the user profile.
    apicall_no_api_key( // no api key -- should 404
      "GET", user.api_urls.profile, null, { },
      404, "text/plain");
    test.apicall( // ok
      "GET", user.api_urls.profile, null, { },
      200, "application/json",
      function(body, headers, test) {
        test.equal(body.name, user.name, "name is correct");
    });
    
    // documents list (currently empty)
    apicall_no_api_key( // no api key
      "GET", user.api_urls.documents, null, { },
      404, "text/plain");
    test.apicall( // ok
      "GET", user.api_urls.documents, null, { },
      200, "application/json",
      function(body, headers, test) {
        test.ok(Array.isArray(body), "response is array");
        test.equal(body.length, 0);
    });

    // update user's name and profile and check we get it back
    test.apicall( // update
      "PUT", user.api_urls.profile,
      { "name": "test-user-1", "profile": { "key": "value" } }, { },
      200, "application/json",
      function(body, headers, test) {
        test.equal(body.name, "test-user-1", "name is correct");
        test.strictSame(body.profile, { "key": "value" }, "profile is correct");
    })
    .then(() => {
      test.apicall( // check
        "GET", user.api_urls.profile, null, { },
        200, "application/json",
        function(body, headers, test) {
          test.equal(body.name, "test-user-1", "name is correct");
          test.strictSame(body.profile, { "key": "value" }, "profile is correct");
      });
    })
  });
});

test.test("Document Tests", {}, function(test) {
  // Create a user
  test.apicall(
    "POST", "/api/v1/users", null, {},
    200, "application/json",
    function(body, headers, test) {
    test.ok(body.id, 'user has id');
    test.ok(body.name, 'user has name');
    test.ok(headers['x-api-key'], 'response has api key header')
  })
  .then((res) => {
    var user = res.body;
    var api_key = res.headers['x-api-key'];

    // From now on, always pass an API key.
    var apicall_no_api_key = test.apicall;
    test.apicall = function(method, path, body, headers, expected_response_code, expected_response_type, check_response) {
      headers['Authorization'] = api_key;
      return apicall_no_api_key(method, path, body, headers, expected_response_code, expected_response_type, check_response);
    };

    // create a document
    apicall_no_api_key( // no api key
      "POST", user.api_urls.documents, null, { },
      404, "text/plain",
      function(body, headers, test) {
    });
    test.apicall( // ok
      "POST", user.api_urls.documents,
      { "name": "test-document-1" },
      { },
      200, "application/json",
      function(body, headers, test) {
        test.equal(body.name, "test-document-1", "name is correct");
        test.equal(body.owner.id, user.id, "owner is correct");
    })
    .then((res) => {
      var doc = res.body;

      // update document metadata
      apicall_no_api_key( // no api key
        "PUT", doc.api_urls.document, null, { },
        404, "text/plain");
      test.apicall( // update
        "PUT", doc.api_urls.document,
        { "name": "test-doc-1" },
        { },
        200, "application/json",
        function(body, headers, test) {
          test.equal(body.name, "test-doc-1", "name is correct");
      })
      .then(() => {
        test.apicall( // check
          "GET", doc.api_urls.document, null,
          { },
          200, "application/json",
          function(body, headers, test) {
            test.equal(body.name, "test-doc-1", "name is correct");
        });
      })
      .then(() => {
        // delete
        apicall_no_api_key( // no api key
          "DELETE", doc.api_urls.document, null, { },
          404, "text/plain");
        test.apicall( // ok
          "DELETE", doc.api_urls.document, null, { },
          200, "text/plain");
      })
    }); // document

    // create a text document
    test.apicall(
      "POST", user.api_urls.documents,
      { "name": "test-document-2" },
      { },
      200, "application/json",
      function(body, headers, test) {
        test.equal(body.name, "test-document-2", "name is correct");
      })
    .then((res) => {
        var doc = res.body;

        // check that it appears in the user's document list
        test.apicall(
          "GET", user.api_urls.documents, null, { },
          200, "application/json",
          function(body, headers, test) {
            test.ok(Array.isArray(body), "response is array");
            // Since the tests may run out of order, we don't
            // know how many array elements to expect, but
            // we should find the new document in it.
            body = body.filter((item) => item.id == doc.id);
            test.equal(body.length, 1, "found document in result");
        });

        // get content
        apicall_no_api_key( // no api key
          "GET", doc.api_urls.content, null, { },
          404, "text/plain");
        test.apicall( // invalid revision
          "GET", doc.api_urls.content, null,
          { 'Revision-Id': 'invalid' },
          404, "text/plain");
        test.apicall( // ok
          "GET", doc.api_urls.content, null, { },
          200, "application/json",
          function(body, headers, test) {
            test.equal(body, null); // new documents always start as null
            test.equal(headers['revision-id'], 'singularity', "at first revision");
            test.equal(headers['access-level'], 'ADMIN', "permission in header is correct");
        });
        test.apicall( // ok - with revision
          "GET", doc.api_urls.content, null,
          { "Revision-Id": "singularity" },
          200, "application/json",
          function(body, headers, test) {
            test.equal(body, null, "document starts empty"); // new documents always start as null
            test.equal(headers['revision-id'], 'singularity', "at first revision");
        });

        // update content
        apicall_no_api_key( // no api key
          "PUT", doc.api_urls.content, null, { },
          404, "text/plain");
        test.apicall( // with plain text body
          "PUT", doc.api_urls.content,
          "Hello world!",
          { },
          200, "application/json",
          function(body, headers, test) {
            test.ok(body.id)
            test.same(body.author.id, user.id);
            test.same(body.status, "committed");
          })
        .then((res) => {
          // check it was committed
          var initial_revision_id = res.body.id;
          test.apicall(
            "GET", doc.api_urls.document + "/history/" + initial_revision_id, null, { },
            200, "application/json",
            function(body, headers, test) {
              test.equal(body.status, "committed");
              test.same(body.op, { _ver: 1, _type: 'values.SET', value: 'Hello world!' });
          });

          test.apicall( // send the same text again and check we get a 204 status code
            "PUT", doc.api_urls.content,
            "Hello world!",
            { },
            204, "application/json");

          // make a second change
          test.apicall(
            "PUT", doc.api_urls.content,
            "Hello cruel world!",
            { "Revision-UserData": '{ "key": "value" }' },
            200, "application/json",
            function(body, headers, test) {
              test.ok(body.id)
              test.same(body.author.id, user.id);
              test.same(body.status, "committed");
              test.same(body.userdata, { "key": "value" });
            })
          .then((res) => {
            // check it was committed
            test.apicall(
              "GET", doc.api_urls.document + "/history/" + res.body.id, null, { },
              200, "application/json",
              function(body, headers, test) {
                test.ok(body.id)
                test.equal(body.status, "committed");
                test.same(body.op, {"_ver":1,"_type":"sequences.PATCH","hunks":[{"offset":6,"length":0,"op":{"_type":"values.SET","value":"cruel "}}]});
            });

            // Make with changes against the first revision, which will be rebased.
            test.apicall(
              "PUT", doc.api_urls.content,
              "Hello fine world!",
              { "Base-Revision-Id": initial_revision_id },
              200, "application/json",
              function(body, headers, test) {
                test.ok(body.id)
                test.same(body.author.id, user.id);
                test.same(body.status, "committed");
              })
            .then((res) => {
              var final_revision_id = res.body.id;

              // check it was committed
              test.apicall(
                "GET", doc.api_urls.document + "/history/" + final_revision_id, null, { },
                200, "application/json",
                function(body, headers, test) {
                  test.ok(body.id)
                  test.equal(body.status, "committed");
                  test.same(body.op, {"_ver":1,"_type":"sequences.PATCH","hunks":[{"offset":12,"length":0,"op":{"_type":"values.SET","value":"fine "}}]});
              });

              // check updated content
              test.apicall( // ok - requesting text
                "GET", doc.api_urls.content, null,
                { "Accept": "text/plain" },
                200, "text/plain",
                function(body, headers, test) {
                  test.equal(body, "Hello cruel fine world!");
                  test.equal(headers['revision-id'], final_revision_id);
              });
              test.apicall( // ok - requesting JSON
                "GET", doc.api_urls.content, null, { },
                200, "application/json",
                function(body, headers, test) {
                  test.equal(body, "Hello cruel fine world!");
                  test.equal(headers['revision-id'], final_revision_id);
              });
              test.apicall( // ok - with revision
                "GET", doc.api_urls.content, null,
                { "Revision-Id": initial_revision_id },
                200, "application/json",
                function(body, headers, test) {
                  test.equal(body, "Hello world!");
                  test.equal(headers['revision-id'], initial_revision_id);
              });

              // check history
              test.apicall( // ok
                "GET", doc.api_urls.history, null, { },
                200, "application/json",
                function(body, headers, test) {
                  test.equal(body.length, 3);
                  test.equal(body[0].id, initial_revision_id);
                  test.equal(body[2].id, final_revision_id);
              });
            });
          });
        });
    }); // document

    // create a JSON document 
    test.apicall(
      "POST", user.api_urls.documents,
      { "name": "test-document-3" },
      { },
      200, "application/json")
    .then((res) => {
      var doc = res.body;

      // set initial content
      test.apicall(
        "PUT", doc.api_urls.content,
        { "key": "Hello world!" },
        { },
        200, "application/json",
        function(body, headers, test) {
          test.ok(body.id)
          test.same(body.author.id, user.id);
          test.same(body.status, "committed");
        })
      .then((res) => {
        var initial_revision_id = res.body.id;

        // check it was committed
        test.apicall(
          "GET", doc.api_urls.document + "/history/" + initial_revision_id, null,
          { },
          200, "application/json",
          function(body, headers, test) {
            test.equal(body.status, "committed");
            test.same(body.op, { _ver: 1, _type: 'values.SET', value: { key: 'Hello world!' } });
        });

        // update using pointer
        test.apicall(
          "PUT", doc.api_urls.content + "/key",
          "Hello cruel world!",
          { },
          200, "application/json")
        .then((res) => {
          var previous_revision_id = res.body.id;
          
          // check it was committed
          test.apicall(
            "GET", doc.api_urls.document + "/history/" + previous_revision_id, null, { },
            200, "application/json",
            function(body, headers, test) {
              test.equal(body.status, "committed");
              test.same(body.op, {"_ver":1,"_type":"objects.APPLY","ops":{"key":{"_type":"sequences.PATCH","hunks":[{"offset":6,"length":0,"op":{"_type":"values.SET","value":"cruel "}}]}}});
          });

          // check using history with 'since' and 'path'
          test.apicall(
            "GET", doc.api_urls.history + "?since=" + initial_revision_id + "&path=/key", null, { },
            200, "application/json",
            function(body, headers, test) {
              test.same(body.length, 1);
              test.same(body[0].op, {"_ver":1,"_type":"sequences.PATCH","hunks":[{"offset":6,"length":0,"op":{"_type":"values.SET","value":"cruel "}}]});
          });

          // check updated content
          test.apicall(
            "GET", doc.api_urls.content, null, { },
            200, "application/json",
            function(body, headers, test) {
              test.same(body, { key: "Hello cruel world!" });
          });
          test.apicall( // with pointer & Acccept header
            "GET", doc.api_urls.content + "/key", null,
            { "Accept": "text/plain" },
            200, "text/plain",
            function(body, headers, test) {
              test.same(body, "Hello cruel world!");
          });

          // update using PATCH
          const jot = require("jot");
          var op = new jot.APPLY("key2", new jot.SET("value2")).toJSON();
          test.apicall(
            "PATCH", doc.api_urls.content,
            op,
            { },
            200, "application/json")
          .then((res) => {
            // check it was committed
            test.apicall(
              "GET", doc.api_urls.document + "/history/" + res.body.id, null, { },
              200, "application/json",
              function(body, headers, test) {
                test.equal(body.status, "committed");
                test.same(body.op, op);
            });

            // check updated content
            test.apicall(
              "GET", doc.api_urls.content, null, { },
              200, "application/json",
              function(body, headers, test) {
                test.same(body, { key: "Hello cruel world!", key2: "value2" });
            });

            // get history with 'since' and 'path', which is evaluated
            // at the 'since' revision. 'key2' doesn't exist at previous_revision_id,
            // so we can check 'key' instead. There have been no changes to
            // 'key' since then.
            test.apicall(
              "GET", doc.api_urls.history + "?since=" + previous_revision_id + "&path=/key", null,
              { },
              200, "application/json",
              function(body, headers, test) {
                test.same(body, []);
            });

            // get history with 'since' without a path.
            test.apicall(
              "GET", doc.api_urls.history + "?since=" + previous_revision_id, null,
              { },
              200, "application/json",
              function(body, headers, test) {
                test.same(body.length, 1);
                test.same(body[0].op, op);
            });
          });
        });
      });

    }); // document

  }); // user

})

// TODO: Check creating an owned user.

// TODO: Check document team permissions.

