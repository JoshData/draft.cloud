# Draft.Cloud

(This project is not open source.)

## Installation

Install node and packages:

	cd ~ # go to home directory, nvm install gets confused if there's a .git dir
	curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.3/install.sh | bash
	nvm install $(nvm ls-remote | tail -1)

	cd draft.cloud
	npm install

Test functionality:

	./build.sh
	node index.js
	  ^C it once it starts running

Testing using the command line & browser. Install `jq` first.

	# Create a new user:
	backend/req POST '' users

	# The user's API key is returned in the X-Api-Key HTTP header.
	# Copy it into an environment variable:
	export API_KEY=(copy X-Api-Key header here)

	# Create a document:
	backend/req POST '' documents/me

	# Copy the "web_urls" => "document" value into your browser to
	# edit the document. Lose the URL? List your documents:
	backend/req GET '' documents/me

Using a browser extension to add HTTP headers to requests, and add an API key header:

	Authorization: {your API key}

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
