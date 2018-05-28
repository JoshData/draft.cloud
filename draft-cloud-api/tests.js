var tap = require('tap');
var routes = require('./routes.js');
const http = require('http');

function run_tests(tests) {
  // Start the test server and create a function to make API calls.
  routes.start_test_server(function(hostname, port, finished) {
    function api_request(method, path, body, headers, expected_response_code, expected_response_type, test, cb) {
      var postData = body ? JSON.stringify(body) : "";
      postData = Buffer.from(postData);

      var request_headers = {
        'Content-Type': 'application/json',
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

    // create another document
    apitest(
      "POST", user.api_urls.documents,
      { "name": "test-document-2" },
      { "Authorization": api_key },
      200, "application/json",
      function(body, headers, test) {
        test.equal(body.name, "test-document-2");
        var doc = body;

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

        // TODO: Get content with a JSON pointer.

        // TODO: Get content with an Accepts: text/plain header.

    }); // document
  
  }); // user

  // TODO: Check creating an owned user.

  // TODO: Check document team permissions.

})