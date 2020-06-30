var tap = require('tap');
var routes = require('../routes.js');
const http = require('http');

// Start the test server and create a function to make API calls.
// Pass that function to the tests callback.
exports.test = function(name, options, test_function) {
  // Start a test.
  var test = tap.test(name, options, (test) => {
    // Start a test server.
    routes.start_test_server(function(hostname, port, finished) {
      // Destroy the test server when the test ends.
      test.tearDown(finished);
      test.autoend(true);

      // Set context to API calls know the server's address.
      test.context = { };
      test.context.hostname = hostname;
      test.context.port = port;

      // Attach a method to the test object for calling the API.
      test.apicall = function(method, path, body, headers, expected_response_code, expected_response_type, check_response) {
        return apitest(test, method, path, body, headers, expected_response_code, expected_response_type, check_response);
      };

      // Run the tests, passing the tap test object.
      test_function(test);
    })
  });
}

// This function wraps http.request and runs an assert on the response code and
// response type and calls check_response with the response body, headers, and
// tap test so that the caller can run additional checks. It returns a Promise
// so that additional apitest calls can be run synchronously after the completion
// of this call, without having to embed them in the check_response callback.
function apitest(test, method, path, body, headers, expected_response_code, expected_response_type, check_response) {
  // Allow path to start with http://hostname:port but strip it off
  // here because it doesn't make sense within the request or in
  // test output.
  var baseurl = "http://" + test.context.hostname + ":" + test.context.port;
  if (path.substring(0, baseurl.length) == baseurl)
    path = path.substring(baseurl.length);

  return new Promise((resolve, reject) => {
    // Start a sub-test for this API call.
    test.test(method + ' ' + path, (subtest) => {
      // Call the API.
      api_request(test.context.hostname, test.context.port, method, path, body, headers, expected_response_code, expected_response_type, subtest, (response_body, response_headers) => {
        // If the API call succeeded check the response body. The
        // check_response method must be synchronous --- to do
        // something asynchronous, use the promise.
        if (typeof response_body != "undefined" && check_response)
          check_response(response_body, response_headers, subtest);

        // End the subtest.
        subtest.end();

        // When the subtest finishes, resolve the promise so that
        // further API calls can be run after this one finishes.
        // If everything passed, resolve the promise (i.e. pass
        // to the 'then' function) the response body and headers
        // as an object with 'body' and 'headers' keys.
        // If anything failed, end the parent test;
        if (typeof response_body != "undefined" && subtest.passing()) {
          resolve({ body: response_body, headers: response_headers });
        } else {
          test.end();
          reject();
        }
      })
    });
  });
}

// This function wraps http.request and runs an assert on the
// response code and response Content-Type. If the asserts pass,
// it calls cb with the response body and headers. If the asserts
// fail, it calls cb without arguments.
function api_request(hostname, port, method, path, body, headers, expected_response_code, expected_response_type, test, cb) {
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
      test.equal(res.statusCode, expected_response_code, ' => ' + expected_response_code);

      // The 'No Content' status means there is no Content-Type header or
      // response body. So there is nothing to check except that we expect
      // this code.
      if (res.statusCode == 204) {
        cb('', res.headers);
        return;
      }

      var content_type = res.headers['content-type'].replace(/;.*/, '');
      var response_body;
      if (content_type == "application/json")
        response_body = JSON.parse(buffer);
      else
        response_body = buffer.toString("utf8");

      test.equal(content_type, expected_response_type, ' => ' + expected_response_type);
      if (res.statusCode != expected_response_code || content_type != expected_response_type)
        test.notOk(response_body, response_body);

      if (res.statusCode == expected_response_code)
        cb(response_body, res.headers);
      else
        cb();
    });

  });

  req.on('error', (e) => {
    test.fail(e.message);
    cb();
  });

  // write data to request body
  req.write(postData);
  req.end();
};