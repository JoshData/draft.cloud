var test = require("./test_harness.js");

test.test("Fork/Merge", {}, function(test) {
  // Create a user
  test.apicall(
    "POST", "/api/v1/users", null, {},
    200, "application/json")
  .then((res) => {
    var user = res.body;
    var api_key = res.headers['x-api-key'];

    // From now on, always pass an API key.
    var apicall_no_api_key = test.apicall;
    test.apicall = function(method, path, body, headers, expected_response_code, expected_response_type, check_response) {
      headers['Authorization'] = api_key;
      return apicall_no_api_key(method, path, body, headers, expected_response_code, expected_response_type, check_response);
    };

    // create a text document
    test.apicall(
      "POST", user.api_urls.documents,
      { "name": "base-document" },
      { }, 200, "application/json")
    .then((res) => {
      var base_doc = res.body;

      // update content
      test.apicall(
        "PUT", base_doc.api_urls.content,
        "Hello world!",
        { }, 200, "application/json")
      .then((res) => {
        var fork_revision_id = res.body.id;

        // fork
        test.apicall(
          "POST", user.api_urls.documents,
          { "name": "child-document", "forkedFrom": fork_revision_id },
          { }, 200, "application/json")
        .then((res) => {
          var child_doc = res.body;

          // update content in each document
          test.apicall(
            "PUT", base_doc.api_urls.content,
            "Goodbye world!",
            { }, 200, "application/json")
          .then(() => {
            // Check that it is committed.
            test.apicall(
              "GET", base_doc.api_urls.document + "/history",
              null, { }, 200, "application/json", (body, headers) => {
                test.equal(body.length, 2);
              });
          })
          .then(() => {
            test.apicall(
              "PUT", child_doc.api_urls.content,
              "Hello cruel world!",
              { }, 200, "application/json")
            .then((res) => {
              // child revision id
              var child_rev = res.body.id;

              // Do a merge dry-run with a GET request.
              test.apicall(
                "GET", base_doc.api_urls.document + "/merge/" + child_rev,
                "", { }, 200, "application/json",
                (body, headers, test) => {
                  test.deepEqual(body.op, { _ver: 1, _type: 'sequences.PATCH', hunks: [ { offset: 8, length: 0, op: { _type: 'values.SET', value: 'cruel ' } } ] },
                    "merge operation is correct");
                });

              // merge
              test.apicall(
                "POST", base_doc.api_urls.document + "/merge/" + child_rev,
                "", { }, 200, "application/json",
                (body, headers, test) => {
                  test.deepEqual(body.op, { _ver: 1, _type: 'sequences.PATCH', hunks: [ { offset: 8, length: 0, op: { _type: 'values.SET', value: 'cruel ' } } ] },
                    "merge operation is correct");
                  test.equal(body.merges.owner, user.id);
                  test.equal(body.merges.document, child_doc.id);
                  test.equal(body.merges.revision, child_rev);
                })
              .then((res) => {
                // Check content.
                test.apicall(
                  "GET", base_doc.api_urls.document + "/content",
                  null, { Accept: "text/plain" }, 200, "text/plain", (body, headers) => {
                    test.equal(body, "Goodbye cruel world!", "merged content is correct");
                  });

                // Check history.
                test.apicall(
                  "GET", base_doc.api_urls.document + "/history",
                  null, { }, 200, "application/json", (body, headers) => {
                    test.equal(body[2].merges.owner, user.id);
                    test.equal(body[2].merges.document, child_doc.id);
                    test.equal(body[2].merges.revision, child_rev);
                  });
              })
              .then((res) => {
                // Make a second edit to each document.
                test.apicall(
                  "PUT", base_doc.api_urls.content,
                  "He said, 'Goodbye cruel world!'",
                  { }, 200, "application/json")
                .then(() => {
                  test.apicall(
                    "PUT", child_doc.api_urls.content,
                    "Hello cruel and unforgiving world!",
                    { }, 200, "application/json")
                  .then((res) => {
                    var child_rev = res.body.id;

                    // Merge again!
                    test.apicall(
                      "POST", base_doc.api_urls.document + "/merge/" + child_rev,
                      { },
                      { }, 200, "application/json",
                      (body, headers, test) => {
                        test.deepEqual(body.op, { _ver: 1, _type: 'sequences.PATCH', hunks: [ { offset: 24, length: 0, op: { _type: 'values.SET', value: 'and unforgiving ' } } ] },
                          "operation is correct");
                        test.equal(body.merges.owner, user.id);
                        test.equal(body.merges.document, child_doc.id);
                        test.equal(body.merges.revision, child_rev);
                      })
                    .then((res) => {

                      // Check content.
                      test.apicall(
                        "GET", base_doc.api_urls.document + "/content",
                        null, { Accept: "text/plain" }, 200, "text/plain", (body, headers) => {
                          test.equal(body, "He said, 'Goodbye cruel and unforgiving world!'", "merged content is correct");
                        });

                        // Make a third edit to each document.
                        test.apicall(
                          "PUT", base_doc.api_urls.content,
                          "He said, 'Arrivederci cruel universe!'",
                          { }, 200, "application/json")
                        .then(() => {
                          test.apicall(
                            "PUT", child_doc.api_urls.content,
                            "Hello wonderous and unforgiving world!",
                            { }, 200, "application/json")
                          .then((res) => {
                            var child_rev = res.body.id;

                            // Merge again!
                            test.apicall(
                              "POST", base_doc.api_urls.document + "/merge/" + child_rev,
                              { }, { }, 200, "application/json",
                              (body, headers, test) => {
                                //test.deepEqual(body.op, { _ver: 1, _type: 'sequences.PATCH', hunks: [ { offset: 8, length: 0, op: { _type: 'values.SET', value: 'cruel ' } } ] },
                                //  "operation is correct");
                                test.equal(body.merges.owner, user.id);
                                test.equal(body.merges.document, child_doc.id);
                                test.equal(body.merges.revision, child_rev);
                              })
                            .then((res) => {
                              // Check content.
                              test.apicall(
                                "GET", base_doc.api_urls.document + "/content",
                                null, { Accept: "text/plain" }, 200, "text/plain", (body, headers) => {
                                  test.equal(body, "He said, 'Arrivederci wonderous universe!'", "merged content is correct");
                                });
                            });
                          })
                        });
                    });
                  })
                });
              });
            });
          });
        });
      });
    }); // document
  }); // user
})
