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

Testing using the command line and our helper script that makes HTTP REST API calls using `curl`. Start by making a new user:

	backend/req POST '{ "name": "user1" }' users

Output:

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

	backend/req POST '{ "name": "document1" }' documents/me

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

	backend/req GET '' documents/me

Now you can edit this document in two ways...

### Using the Draft.Cloud front-end

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

If running with a Postgres database:

	npm install pg # requires Postgresql's JSON column type

Configure nginx and supervisor:

	sudo ln -sf /home/draftdotcloud/draft.cloud/conf/nginx.conf /etc/nginx/sites-enabled/draftdotcloud
	sudo ln -sf /home/draftdotcloud/draft.cloud/conf/supervisor.ini /etc/supervisor/conf.d/draftdotcloud.conf

## Development

Run tests:

	npm test

Build documentation:

	node_modules/spectacle-docs/bin/spectacle.js -t public_html/apidocs/v1 backend/swagger.yaml
