let express = require('express');
let app = express();
let cfenv = require('cfenv');
const got = require('got');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);
const fs = require('fs');

app.enable('trust proxy');

app.use(function (req, res, next) {
  if (req.secure) {
    next();
  } else {
    console.log('redirecting to https');
    res.redirect('https://' + req.headers.host + req.url);
  }
});

const repositories = [];

const { url, account } = JSON.parse(fs.readFileSync('./repository.json'));
if (url) {
  let secret = '';
  if (account) secret = new Buffer.from(`${account}`).toString('base64');
  url.replace(/\r/g, '').split('\n').filter(e => e).forEach(repo => {
    repositories.push({
      url: repo,
      secret,
      useDatabase: true,
      token: ''
    });
  });
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

let mydb = [], cloudant;

function getAll(id) {
  return new Promise((res, rej) => {
    mydb[id].find({
      selector: { _id: { $gt: '0' } },
      fields: ['_id', 'name', 'type', 'digest', 'size', 'uploadTime', 'uuid'],
      sort: [{ uploadTime: 'desc' }]
    }, function (err, body) {
      if (!err) res(body);
      else rej(err);
    });
  });
};

// load local VCAP configuration  and service credentials
let vcapLocal;
try {
  vcapLocal = require('./vcap-local.json');
  console.log('Loaded local VCAP', JSON.stringify(vcapLocal));
} catch (e) { }

const appEnvOpts = vcapLocal ? { vcap: vcapLocal } : {};

const appEnv = cfenv.getAppEnv(appEnvOpts);

if (appEnv.services['cloudantNoSQLDB'] || appEnv.getService(/[Cc][Ll][Oo][Uu][Dd][Aa][Nn][Tt]/)) {
  let Cloudant = require('@cloudant/cloudant');
  const vcap = appEnv.services['cloudantNoSQLDB'][0];
  console.log(vcap);
  if (vcapLocal) {
    cloudant = Cloudant(vcap.credentials);
  }
  else if (vcap) {
    let cloudantURL = vcap.credentials.url;
    let cloudantAPIKey = vcap.credentials.apikey;
    if (cloudantAPIKey) cloudant = Cloudant({ url: cloudantURL, plugins: { iamauth: { iamApiKey: cloudantAPIKey } } });
    else cloudant = Cloudant(vcap.credentials);
  } else {
    // user-provided service with 'cloudant' in its name
    cloudant = Cloudant(appEnv.getService(/cloudant/).credentials);
  }
} else if (process.env.CLOUDANT_URL) {
  // Load the Cloudant library.
  console.log(JSON.stringify(process.env));
  let Cloudant = require('@cloudant/cloudant');
  if (process.env.CLOUDANT_IAM_API_KEY) { // IAM API key credentials
    let cloudantURL = process.env.CLOUDANT_URL;
    let cloudantAPIKey = process.env.CLOUDANT_IAM_API_KEY;
    cloudant = Cloudant({ url: cloudantURL, plugins: { iamauth: { iamApiKey: cloudantAPIKey } } });
  } else { //legacy username/password credentials as part of cloudant URL
    cloudant = Cloudant(process.env.CLOUDANT_URL);
  }
}

if (cloudant) {
  repositories.forEach(repository => {
    const dbName = repository.url.replace(/\//g, '-').replace(/\./g, '_');
    cloudant.db.create(dbName, (err) => {
      if (!err) console.log(`Created database: ${dbName}`);
      else console.log(`Database exists: ${dbName}`);
    });
    mydb.push(cloudant.db.use(dbName));
  });
}

async function getToken(authenticateHeader, id) {
  if (!authenticateHeader) throw '获取认证header失败';
  const [, realm, service, , scope] = authenticateHeader.match(/^Bearer realm="([^"]*)",service="([^"]*)"(,scope="([^"]*)"|)/) || [];
  if (realm && service) {
    let authenticateURL = `${realm}?service=${service}`;
    if (scope) authenticateURL += `&scope=${scope}`;
    const headers = {};
    if (repositories[id].secret) headers['Authorization'] = `Basic ${repositories[id].secret}`;
    const { body } = await got.get(authenticateURL, {
      headers,
      timeout: { request: 10000 },
      responseType: 'json'
    });
    console.log('成功获取新的token');
    return body.token;
  }
  else throw '获取token失败';
}

async function requestSender(url, options, id) {
  const token = repositories[id].token;
  const defaultOptions = {
    timeout: { request: 60000 },
    headers: {}
  };
  if (token) {
    defaultOptions.headers['Authorization'] = `Bearer ${token}`;
  }
  const client = got.extend(defaultOptions).extend(options);
  try {
    return await client(url);
  }
  catch (error) {
    const { statusCode, headers } = error.response || {};
    if (statusCode === 401) {
      try {
        const newToken = await getToken(headers['www-authenticate'], id);
        if (newToken) {
          repositories[id].token = newToken;
        }
        else throw '获取token失败';
        return await client(url, {
          headers: {
            'Authorization': `Bearer ${newToken}`
          }
        });
      }
      catch (error) {
        console.log(error);
        const { statusCode, headers } = error.response || {};
        if (statusCode === 401) throw { message: 'need login', authenticateHeader: headers['www-authenticate'] };
        else throw '认证失败';
      }
    }
    throw error;
  }
}

async function getDownloadURL(digest, id) {
  const [server, namespace, image] = repositories[id].url.split('/') || [];
  const url = `https://${server}/v2/${namespace}/${image}/blobs/${digest}`;
  const options = {
    headers: {
      'repository': [server, namespace, image].join('/')
    },
    timeout: { request: 10000 },
    followRedirect: false
  };
  const { headers } = await requestSender(url, options, id);
  return headers.location;
}

function parseDatabaseConfig(array) {
  const mark = {};
  const root = [];
  let id = 0;
  array.forEach(item => {
    item.id = ++id;
    if (item.type === 'folder') {
      mark[item.uuid] = item;
      item.files = [];
    }
  });
  array.forEach(item => {
    const [parent] = item._id.split(':');
    if (parent === 'root') root.push(item);
    else mark[parent].files.push(item);
  });
  const files = new Set();
  array.forEach(item => item.type === 'file' ? files.add(`${item.digest}|${item.size}`) : '');
  return root;
}

function errorHandler(error, response) {
  if (error.response) {
    console.log(error.response.body);
    console.log(`Method: ${error.response.request.options.method}`);
    console.log(`URL: ${error.response.requestUrl}`);
    console.log(`Status Code: ${error.response.statusCode}`);
    console.log('Headers:');
    console.log(error.response.headers);
  }
  else console.error(error);
  if (response) response.status(400).send({
    message: '未知错误'
  });
}

app.get('/api/manifests', async (request, response) => {
  try {
    const id = (parseInt(request.query.repo) || 1) - 1;
    if (repositories[id].useDatabase && mydb[id]) {
      const { docs } = await getAll(id);
      response.send({ files: parseDatabaseConfig(docs) });
    }
    else {
      const [server, namespace, image] = repositories[id].url.split('/') || [];
      const manifestsURL = `https://${server}/v2/${namespace}/${image}/manifests/latest`;
      const manifestsOptions = ({
        headers: {
          'Accept': 'application/vnd.docker.distribution.manifest.v2+json',
          'repository': [server, namespace, image].join('/')
        },
        responseType: 'json'
      });
      const { body } = await requestSender(manifestsURL, manifestsOptions, id);
      const configUrl = await getDownloadURL(body.config.digest, id);
      const { body: config } = await got(configUrl);
      response.send(config);
    }
  }
  catch (error) {
    const { statusCode } = error.response || {};
    if (statusCode === 404) response.status(404).send({});
    else errorHandler(error, response);
  }
});

app.get('/api/file/:digest', async (request, response) => {
  try {
    const id = (parseInt(request.query.repo) || 1) - 1;
    const downloadUrl = await getDownloadURL(`sha256:${request.params.digest}`, id);
    if (downloadUrl) {
      if (request.query.type === 'download') {
        await pipeline(
          got.stream(downloadUrl),
          response
        );
        response.end();
      }
      else if (request.query.type === 'source') {
        response.redirect(307, downloadUrl);
      }
      else response.send(downloadUrl);
    }
    else response.status(404).send(JSON.stringify({
      message: '找不到文件'
    }));
  }
  catch (error) {
    errorHandler(error, response);
  }
});

//serve static file (index.html, images, css)
app.use(express.static(__dirname + '/views'));

let port = process.env.PORT || 3000;
app.listen(port, function () {
  console.log(`To view your app, open this link in your browser: http://localhost:${port}`);
});
