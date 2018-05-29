var tap = require('tap');
var routes = require('./routes.js');
const http = require('http');

function run_tests(tests) {
  // Start the test server and create a function to make API calls.
  routes.start_test_server(function(hostname, port, finished) {
    function api_request(method, path, body, headers, expected_response_code, expected_response_type, test, cb) {
      var postData;
      var contentType;
      if (!body) {
        postData = '';
        contentType = "text/plain";
      } else if (typeof body == "string") {
        postData = body;
        contentType = "text/plain";
      } else {
        postData = JSON.stringify(body);
        contentType = "application/json";
      }
      postData = Buffer.from(postData);

      var request_headers = {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(postData),
      };
      for (let key in headers)
        request_headers[key] = headers[key];

      const options = {
        hostname: hostname,
        port: port,
        method: method,
        path: path,
        headers: request_headers
      };

      const req = http.request(options, (res) => {
        var buffer = Buffer.from([]);
        res.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
        });
        res.on('end', () => {
          var content_type = res.headers['content-type'].replace(/;.*/, '');
          var response_body;
          if (content_type == "application/json")
            response_body = JSON.parse(buffer);
          else
            response_body = buffer.toString("utf8");

          test.equal(res.statusCode, expected_response_code, method + ' ' + path + ' => ' + expected_response_code);
          test.equal(content_type, expected_response_type, method + ' ' + path + ' => ' + expected_response_type);
          if (res.statusCode != expected_response_code || content_type != expected_response_type)
            test.notOk(response_body, response_body);

          if (res.statusCode == expected_response_code)
            cb(response_body, res.headers);
          else
            test.end();
        });

      });

      req.on('error', (e) => {
        console.log(e)
        test.equal("", e.message);
        test.end();
      });

      // write data to request body
      req.write(postData);
      req.end();
    };

    function apitest(method, path, body, headers, expected_response_code, expected_response_type, check_response) {
      tap.test(method + ' ' + path, function(test) {
        api_request(method, path, body, headers, expected_response_code, expected_response_type, test, function(response_body, response_headers) {
          check_response(response_body, response_headers, test);
          test.end();
        })
      });
    }

    tests(apitest);

    tap.tearDown(finished);
  })
}

run_tests(function(apitest) {

  // nonexistent root path
  apitest(
    "GET", "/", null, {},
    404, "text/html",
    function(body, headers, test) {
    test.match(body, '<pre>Cannot GET /</pre>');
  });


  // TODO: Check when settings.allow_anonymous_user_creation == false.

  // create a user
  apitest(
    "POST", "/api/v1/users", null, {},
    200, "application/json",
    function(body, headers, test) {
    test.ok(body.id, 'user has id');
    test.ok(body.name, 'user has name');
    test.ok(headers['x-api-key'], 'response has api key header')
    
    var user = body;
    var api_key = headers['x-api-key'];

    // user profile
    apitest( // no api key
      "GET", user.api_urls.profile, null,
      { },
      404, "text/plain",
      function(body, headers, test) {
    });
    apitest( // ok
      "GET", user.api_urls.profile, null,
      { "Authorization": api_key },
      200, "application/json",
      function(body, headers, test) {
        test.equal(body.name, user.name)
    });
    
    // documents list (currently empty)
    apitest( // no api key
      "GET", user.api_urls.documents, null, { },
      404, "text/plain",
      function(body, headers, test) {
    });
    apitest( // ok
      "GET", user.api_urls.documents, null,
      { "Authorization": api_key },
      200, "application/json",
      function(body, headers, test) {
        test.ok(Array.isArray(body), "response is array");
        test.equal(body.length, 0);
    });

    // update user's name and profile and check we get it back
    apitest( // update
      "PUT", user.api_urls.profile,
      { "name": "test-user-1", "profile": { "key": "value" } },
      { "Authorization": api_key },
      200, "application/json",
      function(body, headers, test) {
        test.equal(body.name, "test-user-1");
        test.strictSame(body.profile, { "key": "value" });
    });
    apitest( // check
      "GET", user.api_urls.profile, null,
      { "Authorization": api_key },
      200, "application/json",
      function(body, headers, test) {
        test.equal(body.name, "test-user-1");
        test.strictSame(body.profile, { "key": "value" });
    });

    // create a document
    apitest( // no api key
      "POST", user.api_urls.documents, null, {},
      404, "text/plain",
      function(body, headers, test) {
    });
    apitest( // ok
      "POST", user.api_urls.documents,
      { "name": "test-document-1" },
      { "Authorization": api_key },
      200, "application/json",
      function(body, headers, test) {
        test.equal(body.name, "test-document-1");
        var doc = body;

        // update document metadata
        apitest( // no api key
          "PUT", doc.api_urls.document, null, {},
          404, "text/plain",
          function(body, headers, test) {
        });
        apitest( // update
          "PUT", doc.api_urls.document,
          { "name": "test-doc-1" },
          { "Authorization": api_key },
          200, "application/json",
          function(body, headers, test) {
            test.equal(body.name, "test-doc-1");
        });
        apitest( // check
          "GET", doc.api_urls.document, null,
          { "Authorization": api_key },
          200, "application/json",
          function(body, headers, test) {
            test.equal(body.name, "test-doc-1");
        });

        // delete
        apitest( // no api key
          "DELETE", doc.api_urls.document, null, {},
          404, "text/plain",
          function(body, headers, test) {
        });
        apitest( // ok
          "DELETE", doc.api_urls.document, null,
          { "Authorization": api_key },
          200, "text/plain",
          function(body, headers, test) {
        });
    }); // document

    // create a text document
    apitest(
      "POST", user.api_urls.documents,
      { "name": "test-document-2" },
      { "Authorization": api_key },
      200, "application/json",
      function(body, headers, test) {
        test.equal(body.name, "test-document-2");
        var doc = body;

        // check that it appears in the user's document list
        apitest(
          "GET", user.api_urls.documents, null,
          { "Authorization": api_key },
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
        apitest( // no api key
          "GET", doc.api_urls.content, null, {},
          404, "text/plain",
          function(body, headers, test) {
        });
        apitest( // invalid revision
          "GET", doc.api_urls.content, null,
          { 'Revision-Id': 'invalid', "Authorization": api_key },
          404, "text/plain",
          function(body, headers, test) {
        });
        apitest( // ok
          "GET", doc.api_urls.content, null,
          { "Authorization": api_key },
          200, "application/json",
          function(body, headers, test) {
            test.equal(body, null); // new documents always start as null
            test.equal(headers['revision-id'], 'singularity');
            test.equal(headers['access-level'], 'ADMIN');
        });
        apitest( // ok - with revision
          "GET", doc.api_urls.content, null,
          { "Revision-Id": "singularity", "Authorization": api_key },
          200, "application/json",
          function(body, headers, test) {
            test.equal(body, null); // new documents always start as null
            test.equal(headers['revision-id'], 'singularity');
        });

        // update content
        apitest( // no api key
          "PUT", doc.api_urls.content, null, { },
          404, "text/plain",
          function(body, headers, test) {
        });
        apitest( // with plain text body
          "PUT", doc.api_urls.content,
          "Hello world!",
          { "Authorization": api_key },
          201, "application/json",
          function(body, headers, test) {
            var initial_revision_id = body.id;
            test.ok(body.id)
            test.same(body.author.id, user.id);
            test.same(body.status, "committed");

            // check it was committed
            apitest(
              "GET", doc.api_urls.document + "/revision/" + body.id, null,
              { "Authorization": api_key },
              200, "application/json",
              function(body, headers, test) {
                test.equal(body.status, "committed");
                test.same(body.op, { _ver: 1, _type: 'values.SET', value: 'Hello world!' });
            });

            apitest( // with further changes & userdata
              "PUT", doc.api_urls.content,
              "Hello cruel world!",
              { "Revision-UserData": '{ "key": "value" }',
                "Authorization": api_key },
              201, "application/json",
              function(body, headers, test) {
                test.ok(body.id)
                test.same(body.author.id, user.id);
                test.same(body.status, "committed");
                test.same(body.userdata, { "key": "value" });

                // check it was committed
                apitest(
                  "GET", doc.api_urls.document + "/revision/" + body.id, null,
                  { "Authorization": api_key },
                  200, "application/json",
                  function(body, headers, test) {
                    test.ok(body.id)
                    test.equal(body.status, "committed");
                    test.same(body.op, {"_ver":1,"_type":"sequences.PATCH","hunks":[{"offset":6,"length":0,"op":{"_type":"values.SET","value":"cruel "}}]});
                });
            });

            apitest( // with changes against the first revision, which will be rebased
              "PUT", doc.api_urls.content,
              "Hello fine world!",
              { "Base-Revision-Id": body.id,
                "Authorization": api_key },
              201, "application/json",
              function(body, headers, test) {
                test.ok(body.id)
                test.same(body.author.id, user.id);
                test.same(body.status, "committed");
                var final_revision_id = body.id;

                    // check it was committed
                    apitest(
                      "GET", doc.api_urls.document + "/revision/" + body.id, null,
                      { "Authorization": api_key },
                      200, "application/json",
                      function(body, headers, test) {
                        test.ok(body.id)
                        test.equal(body.status, "committed");
                        test.same(body.op, {"_ver":1,"_type":"sequences.PATCH","hunks":[{"offset":12,"length":0,"op":{"_type":"values.SET","value":"fine "}}]});
                    });

                    // check updated content
                    apitest( // ok - requesting text
                      "GET", doc.api_urls.content, null,
                      { "Accept": "text/plain", "Authorization": api_key },
                      200, "text/plain",
                      function(body, headers, test) {
                        test.equal(body, "Hello cruel fine world!");
                        test.equal(headers['revision-id'], final_revision_id);
                    });
                    apitest( // ok - requesting JSON
                      "GET", doc.api_urls.content, null,
                      { "Authorization": api_key },
                      200, "application/json",
                      function(body, headers, test) {
                        test.equal(body, "Hello cruel fine world!");
                        test.equal(headers['revision-id'], final_revision_id);
                    });
                    apitest( // ok - with revision
                      "GET", doc.api_urls.content, null,
                      { "Revision-Id": initial_revision_id, "Authorization": api_key },
                      200, "application/json",
                      function(body, headers, test) {
                        test.equal(body, "Hello world!");
                        test.equal(headers['revision-id'], initial_revision_id);
                    });

                    // check history
                    apitest( // ok
                      "GET", doc.api_urls.history, null,
                      { "Authorization": api_key },
                      200, "application/json",
                      function(body, headers, test) {
                        test.equal(body.length, 3);
                        test.equal(body[0].id, initial_revision_id);
                        test.equal(body[2].id, final_revision_id);
                    });

            });

        });
    }); // document

    // create a JSON document 
    apitest(
      "POST", user.api_urls.documents,
      { "name": "test-document-3" },
      { "Authorization": api_key },
      200, "application/json",
      function(body, headers, test) {
        var doc = body;

        // set initial content
        apitest(
          "PUT", doc.api_urls.content,
          { "key": "Hello world!" },
          { "Authorization": api_key },
          201, "application/json",
          function(body, headers, test) {
            var initial_revision_id = body.id;
            test.ok(body.id)
            test.same(body.author.id, user.id);
            test.same(body.status, "committed");

            // check it was committed
            apitest(
              "GET", doc.api_urls.document + "/revision/" + body.id, null,
              { "Authorization": api_key },
              200, "application/json",
              function(body, headers, test) {
                test.equal(body.status, "committed");
                test.same(body.op, { _ver: 1, _type: 'values.SET', value: { key: 'Hello world!' } });
            });

            // update using pointer
            apitest(
              "PUT", doc.api_urls.content + "/key",
              "Hello cruel world!",
              { "Authorization": api_key },
              201, "application/json",
              function(body, headers, test) {
                var previous_revision_id = body.id;
                
                // check it was committed
                apitest(
                  "GET", doc.api_urls.document + "/revision/" + body.id, null,
                  { "Authorization": api_key },
                  200, "application/json",
                  function(body, headers, test) {
                    test.equal(body.status, "committed");
                    test.same(body.op, {"_ver":1,"_type":"objects.APPLY","ops":{"key":{"_type":"sequences.PATCH","hunks":[{"offset":6,"length":0,"op":{"_type":"values.SET","value":"cruel "}}]}}});
                });

                // check using history with 'since' and 'path'
                apitest(
                  "GET", doc.api_urls.history + "?since=" + initial_revision_id + "&path=/key", null,
                  { "Authorization": api_key },
                  200, "application/json",
                  function(body, headers, test) {
                    test.same(body.length, 1);
                    test.same(body[0].op, {"_ver":1,"_type":"sequences.PATCH","hunks":[{"offset":6,"length":0,"op":{"_type":"values.SET","value":"cruel "}}]});
                });

                // check updated content
                apitest(
                  "GET", doc.api_urls.content, null,
                  { "Authorization": api_key },
                  200, "application/json",
                  function(body, headers, test) {
                    test.same(body, { key: "Hello cruel world!" });
                });
                apitest( // with pointer & Acccept header
                  "GET", doc.api_urls.content + "/key", null,
                  { "Accept": "text/plain", "Authorization": api_key },
                  200, "text/plain",
                  function(body, headers, test) {
                    test.same(body, "Hello cruel world!");
                });

                // update using PATCH
                const jot = require("jot");
                var op = new jot.APPLY("key2", new jot.SET("value2")).toJSON();
                apitest(
                  "PATCH", doc.api_urls.content,
                  op,
                  { "Authorization": api_key },
                  201, "application/json",
                  function(body, headers, test) {
                    // check it was committed
                    apitest(
                      "GET", doc.api_urls.document + "/revision/" + body.id, null,
                      { "Authorization": api_key },
                      200, "application/json",
                      function(body, headers, test) {
                        test.equal(body.status, "committed");
                        test.same(body.op, op);
                    });

                    // check updated content
                    apitest(
                      "GET", doc.api_urls.content, null,
                      { "Authorization": api_key },
                      200, "application/json",
                      function(body, headers, test) {
                        test.same(body, { key: "Hello cruel world!", key2: "value2" });
                    });

                    // get history with 'since' and 'path', which is evaluated
                    // at the 'since' revision. 'key2' doesn't exist at previous_revision_id,
                    // so we can check 'key' instead. There have been no changes to
                    // 'key' since then.
                    apitest(
                      "GET", doc.api_urls.history + "?since=" + previous_revision_id + "&path=/key", null,
                      { "Authorization": api_key },
                      200, "application/json",
                      function(body, headers, test) {
                        test.same(body, []);
                    });


                    // get history with 'since' without a path.
                    apitest(
                      "GET", doc.api_urls.history + "?since=" + previous_revision_id, null,
                      { "Authorization": api_key },
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

  // TODO: Check creating an owned user.

  // TODO: Check document team permissions.

})