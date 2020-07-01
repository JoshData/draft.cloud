# Draft.Cloud

(This project is not open source.)

## Installation

Install node and packages:

	cd ~ # go to home directory, nvm install gets confused if there's a .git dir
	curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.3/install.sh | bash
	nvm install $(nvm ls-remote | tail -1)

	cd draft.cloud
	npm install

Start it up:

	./build.sh
	node index.js --allow_anonymous_user_creation

Testing using the command line and our helper script that makes HTTP REST API calls. Start by making a new user by calling the `/users` API with a POST request:

	backend/req POST '{ "name": "user1" }' /users

`backend/req` is just a helper script that forms an API request using `curl` (so make sure you have `curl` installed). In this first example it makes an HTTP POST request to `http://localhost:8000/api/v1/users` with `{ "name": "user1" }` as the POST request body.

The response will contain a special HTTP header named `X-Api-Key` and the body will be JSON containing information about the newly created user:

	...
	X-Api-Key: bbd5c77f-14ad-4cf4-ac25-fd3e3abecd5c.s2OkOblxRAyvR4sOGmE2JjQRRH/XmcHZ.0
	...

	{
	  "id": "dfb05874-5081-4d16-86d3-80c463cc8277",
	  "name": "user1",
	  "created": "2020-02-16T13:34:39.687Z",
	  "api_urls": {
	    "profile": "http://localhost:8000/api/v1/users/dfb05874-5081-4d16-86d3-80c463cc8277",
	    "documents": "http://localhost:8000/api/v1/documents/dfb05874-5081-4d16-86d3-80c463cc8277"
	  }
	}

Each user has an `id` which is a UUID and a unique `name` which is initialized to a random string if it is not provided in the POST request to create the user.

The user's API key is returned in the `X-Api-Key` HTTP header which you'll see in the response output. Copy it into an environment variable:
	
	export API_KEY=bbd5c77f-14ad-4cf4-ac25-fd3e3abecd5c.s2OkOblxRAyvR4sOGmE2JjQRRH/XmcHZ.0

Then create a document:

	backend/req POST '{ "name": "document1" }' /documents/me

`me` is an alias for your own user `id`.

Output:

	...

	{
	  "id": "ff5a3057-b112-4d05-9de3-9b1c91dec3fa",
	  "name": "document1",
	  "created": "2020-02-16T13:49:46.257Z",
	  "anon_access_level": "NONE",
	  "owner": {
	    "name": "user1",
	    ...
	  },
	  "userdata": {},
	  "api_urls": {
		...
	    "debugger": "http://localhost:8000/api/v1/documents/468604fa-f5cc-44b7-9477-d2c9bd9c7eef/ff5a3057-b112-4d05-9de3-9b1c91dec3fa/debug"
	  },
	  "web_urls": {
	    "document": "http://localhost:8000/edit/user1/document1"
	  }
	}

Like users, each document has an `id` which is a UUID and a `name` which is unique across the user's documents. The name is initialized to a random string if it is not provided in the POST request to create the document.

Need to get this information again? List all of your documents:

	backend/req GET '' /documents/me

Now you can edit this document in three ways...

### Using the Draft.Cloud API

#### Reading and writing document content

The Draft.Cloud API has two methods to update a document: PUTing an updated document or PATCHing a document with a diff in the form of a JOT operation.

First, let's get the current content of the document. Use a GET request and the `id` of the document returned in the previous API call:

	backend/req GET '' /documents/me/ff5a3057-b112-4d05-9de3-9b1c91dec3fa/content

In the HTTP response headers you'll get the `Revision-Id` of the documentation's current revision and in the HTTP response body you will get a JSON value with the document's content:

	Revision-Id: singularity
	...
	null

All Draft.Cloud documents are JSON data structures. All new documents start off holding just the value `null`, and the first `Revision-Id` is always `singularity`.

Now updated it to a text value using a PUT request:

	backend/req PUT '"This is a JSON string value."' /documents/me/ff5a3057-b112-4d05-9de3-9b1c91dec3fa/content

Note that the request body `"This is a JSON string value."` quotes the text because you are submitting a JSON value, not plain text.

The response will have HTTP status code 201 and give information about the new revision of the document:

	{
	  "created": "2020-06-13T12:27:12.989Z",
	  "id": "57cf779f-ac4a-411f-8076-615c9c558b4b",
	  "author": {
	    ...
	    "name": "user1"
	  },
	  "userdata": null,
	  "status": "committed",
	  "op": {
	    "_ver": 1,
	    "_type": "values.SET",
	    "value": "This is a JSON string value."
	  }
	}

If you call the API with the exact same request again, you'll get a response with a 200 status code and a body containing

	no change

because you haven't modified the document. Try again but with "JSON" removed from the text:

	backend/req PUT '"This is a string value."' /documents/me/ff5a3057-b112-4d05-9de3-9b1c91dec3fa/content

The response will show a change starting at character 10 which is automatically computed for you:

	{
	  "created": "2020-06-13T12:32:00.353Z",
	  "id": "605f5561-c69c-4597-babe-ae33c4100d68",
	  ...
	  "op": {
	    "_ver": 1,
	    "_type": "sequences.PATCH",
	    "hunks": [
	      {
	        "offset": 10,
	        "length": 5,
	        "op": {
	          "_type": "values.SET",
	          "value": ""
	        }
	      }
	    ]
	  }
	}

Now you can get the document:

	backend/req GET '' /documents/me/ff5a3057-b112-4d05-9de3-9b1c91dec3fa/content

which returns the `Revision-Id` HTTP header and a JSON value in the response body for the current value of the document:

	Revision-Id: 605f5561-c69c-4597-babe-ae33c4100d68
	...
	"This is a string value."

#### Working with plain text documents

When working with plain text documents, you can use the HTTP Content-Type and Accept headers to simplify. With our helper script, set the `CONTENT_TYPE` environment variable to set the Content-Type header and update the document:

	CONTENT_TYPE=text/plain backend/req PUT 'This is my document.' /documents/me/ff5a3057-b112-4d05-9de3-9b1c91dec3fa/content

Note that the double quotes are now gone from the POST body --- you're submitting plain text, not JSON, now. And set the `ACCEPT` environment variable for our helper script to set the Accept HTTP header toget the text back plainly:

	ACCEPT=text/plain backend/req GET '' /documents/me/ff5a3057-b112-4d05-9de3-9b1c91dec3fa/content

which returns

	Revision-Id: b0ea9d9c-f5f7-4d89-a68e-fb1a8cd590aa
	...
	This is my document.

again, without quotes because this is now plain text, not JSON.

#### Conflict resolution of simultaneous edits

Draft.Cloud automatically resolves conflicts in simultaneous edits when the POST request includes the ID of the revision it last saw in the `Base-Revision-Id` header. Using our helper script, you can set that header by setting the `BASEREV` environment variable.

Let's make two changes. The first change will replace the word `is` with `was`:

	BASEREV=b0ea9d9c-f5f7-4d89-a68e-fb1a8cd590aa backend/req PUT '"This was my document."' /documents/me/ff5a3057-b112-4d05-9de3-9b1c91dec3fa/content

This change is now committed to the document. However, imagine that simultaneously someone else made a different change replacing `document` with `mission`:

	BASEREV=b0ea9d9c-f5f7-4d89-a68e-fb1a8cd590aa backend/req PUT '"This is my mission."' /documents/me/ff5a3057-b112-4d05-9de3-9b1c91dec3fa/content

Note that in this second change, the verb is still `is`!

Will the first API call's change from `is` to `was` be reverted? No, because the `Base-Revision-Id` header was used in the second call. You can get the current value of the document to see:

	ACCEPT=text/plain backend/req GET '' /documents/me/ff5a3057-b112-4d05-9de3-9b1c91dec3fa/content

	Revision-Id: 3754fe48-cb4c-4a7a-bd74-7e22657840d5
	...
	This was my mission.

Always use `Base-Revision-Id` with `POST` requests to update a document when the document might be edited by concurrent processes or users.

### Using the Draft.Cloud front-end

The second and third method uses Draft.Cloud's websocket-based browser widgets.

First you'll need to set up authentication in your browser. Using a browser extension to add HTTP headers to requests, and add a header named `Authorization` and set its value to your API key from above:

	Authorization: bbd5c77f-14ad-4cf4-ac25-fd3e3abecd5c.s2OkOblxRAyvR4sOGmE2JjQRRH/XmcHZ.0

The output of the earlier command to create the document has a `web_urls` => `document` value to view the document in your web browser. In the example it is `http://localhost:8000/edit/user1/document1`. Open that URL.

### Using your own front-end

Because `<script>` tags and websockets are not limited by the browser's same-origin policy, you can immediately place a Draft.Cloud widget on your own website --- so long as the browser can see the server you launched Draft.Cloud on. Here's a snippet to embed the Draft.Cloud rich text editor on your site:

```html
<html>
  <head>
  </head>
  <body>
      <div class="draftdotcloud-widget"
        data-draftdotcloud-widget="quill"
        data-draftdotcloud-owner="user1"
        data-draftdotcloud-document="document1"
        data-draftdotcloud-baseurl="http://localhost:8000"
        data-draftdotcloud-apikey="bbd5c77f-14ad-4cf4-ac25-fd3e3abecd5c.s2OkOblxRAyvR4sOGmE2JjQRRH/XmcHZ.0"
        ></div>
  </body>
    <script src="http://localhost:8000/draftdotcloud.js"> </script>
</html>
```

Instead of a `div`, you can also make any `textarea` or `<input type=text>` a collaborative document:

```html
<textarea class="draftdotcloud-widget"
  data-draftdotcloud-owner="joshdata"
  data-draftdotcloud-document="testdoc"
  data-draftdotcloud-baseurl="http://localhost:8000"
  data-draftdotcloud-apikey="7b88ea21-8992-432d-8c8d-50a0a194d007.3t8LKawKXH/V62O+o5hClAXZ8fEZAcOr.0"
></textarea>
```

It is your web application server's responsibility to provision a Draft.Cloud API key for the end user and embed it within the HTML page.

## Deployment

See the full set of options that you may need to set:

	node index.js --help

Options can be specified in environment variables, on the command-line, or in a configuration file.

You will likely need to set the `URL` and `DATABASE` settings (and possibly also the `BIND_HOST`, `PORT`, and `TRUST_PROXY` settings) either by setting environment variables, a settings file with NAME=VALUE lines, or using the corresponding command-line arguments described in the help output. The `SECRET_KEY` setting is required to enable login sessions (see [express session](https://www.npmjs.com/package/express-session#secret)).

Default values are also shown in the help output. The default database is a Sqlite database named `db.sqlite` stored in the current directory.

If running with a Postgres database you'll need to install the `pg` package:

	npm install pg

Configure nginx and supervisor:

	sudo ln -sf /home/draftdotcloud/draft.cloud/conf/nginx.conf /etc/nginx/sites-enabled/draftdotcloud
	sudo ln -sf /home/draftdotcloud/draft.cloud/conf/supervisor.ini /etc/supervisor/conf.d/draftdotcloud.conf

## Development

Run tests:

	npm test

Build documentation:

	node_modules/spectacle-docs/bin/spectacle.js -t public_html/apidocs/v1 backend/swagger.yaml
