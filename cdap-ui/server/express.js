// @ts-nocheck
/*
 * Copyright © 2015-2018 Cask Data, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

/* global require, module, process, __dirname */
var urlhelper = require('./url-helper');
const url = require('url');
const csp = require('helmet-csp');

module.exports = {
  getApp: function() {
    return require('q')
      .all([
        // router check also fetches the auth server address if security is enabled
        require('./config/router-check.js').ping(),
        require('./config/parser.js').extractConfig('cdap'),
        require('./config/parser.js').extractUISettings(),
      ])
      .spread(makeApp);
  },
};

var path = require('path');
var express = require('express'),
  cookieParser = require('cookie-parser'),
  compression = require('compression'),
  finalhandler = require('finalhandler'),
  serveFavicon = require('serve-favicon'),
  request = require('request'),
  uuidV4 = require('uuid/v4'),
  log4js = require('log4js'),
  bodyParser = require('body-parser'),
  DLL_PATH = path.normalize(__dirname + '/../dll'),
  DIST_PATH = path.normalize(__dirname + '/../dist'),
  LOGIN_DIST_PATH = path.normalize(__dirname + '/../login_dist'),
  CDAP_DIST_PATH = path.normalize(__dirname + '/../cdap_dist'),
  MARKET_DIST_PATH = path.normalize(__dirname + '/../common_dist'),
  fs = require('fs'),
  objectQuery = require('lodash/get');
var log = log4js.getLogger('default');
const uiThemePropertyName = 'ui.theme.file';

const isModeDevelopment = () => process.env.NODE_ENV === 'development';
const isModeProduction = () => process.env.NODE_ENV === 'production';

const getExpressStaticConfig = () => {
  if (isModeDevelopment()) {
    return {};
  }
  return {
    index: false,
    maxAge: '1y',
  };
};

function getFaviconPath(uiThemeConfig) {
  let faviconPath = DIST_PATH + '/assets/img/favicon.png';
  let themeFaviconPath = objectQuery(uiThemeConfig, ['content', 'favicon-path']);
  if (themeFaviconPath) {
    themeFaviconPath = CDAP_DIST_PATH + themeFaviconPath;
    try {
      if (require.resolve(themeFaviconPath)) {
        faviconPath = themeFaviconPath;
      }
    } catch (e) {
      log.warn(`Unable to find favicon at path ${themeFaviconPath}`);
    }
  }
  return faviconPath;
}

function extractUIThemeWrapper(cdapConfig) {
  const uiThemePath = cdapConfig[uiThemePropertyName];
  extractUITheme(cdapConfig, uiThemePath);
}

function extractUITheme(cdapConfig, uiThemePath) {
  const DEFAULT_CONFIG = {};

  if (!(uiThemePropertyName in cdapConfig)) {
    log.warn(`Unable to find ${uiThemePropertyName} property`);
    log.warn(`UI using default theme`);
    return DEFAULT_CONFIG;
  }

  let uiThemeConfig = DEFAULT_CONFIG;
  /**
   *
   * The first check assumes that its linux based environment.
   * FIXME: We should always make the user provide abolute path that way we don't do these hops.
   */
  if (uiThemePath[0] !== '/') {
    // if path doesn't start with /, then it's a relative path
    // have to add the ellipses to navigate back to $CDAP_HOME, before
    // going through the path
    uiThemePath = path.join('..', uiThemePath);
  }
  try {
    if (require.resolve(uiThemePath)) {
      uiThemeConfig = require(uiThemePath);
      log.info(`UI using theme located at ${cdapConfig[uiThemePropertyName]}`);
      return uiThemeConfig;
    }
  } catch (e) {
    // Theme file not found in: ${uiThemePath}
  }
  try {
    /**
     * This extra check is required in a non-built environment (during development) as opposed to
     *  a built environment like SDK or clusters where we have the node app built using ncc
     *  which takes away the folder structure and builds everything to single file.
     *
     * Non-built folder structure
     * ui/
     *   server.js
     *   server/
     *     config/
     *       themes/
     *         default.json
     *     parser.js -> file lookup happens here
     *
     * Built node app folder structure
     *
     * ui/
     *   index.js -> file lookup happens here
     *   server/
     *     config/
     *       themes/
     *         default.json
     *
     * Going two levels up won't be correct in the new structure. Hence the check in first try catch.
     */
    uiThemePath = path.join('..', uiThemePath);
    if (require.resolve(uiThemePath)) {
      uiThemeConfig = require(uiThemePath);
      log.info(`UI using theme located at ${uiThemePath}`);
      return uiThemeConfig;
    }
  } catch (e) {
    // The error can either be file doesn't exist, or file contains invalid json
    log.error(e.toString());
    log.warn(`UI using default theme`);
    throw e;
  }
  return uiThemeConfig;
}

function makeApp(authAddress, cdapConfig, uiSettings) {
  var app = express();
  let uiThemeConfig = {};
  try {
    uiThemeConfig = extractUIThemeWrapper(cdapConfig);
  } catch (e) {
    // This means there was error reading the theme file.
    // We can ignore this as the extract theme takes care of it.
  }
  const faviconPath = getFaviconPath(uiThemeConfig);
  // middleware
  try {
    app.use(serveFavicon(faviconPath));
  } catch (e) {
    log.error('Favicon missing! Please run `gulp build`');
  }

  app.use(compression());
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(cookieParser());

  if (!isModeDevelopment()) {
    let marketUrl = url.parse(cdapConfig['market.base.url']);
    let imgsrc = `${marketUrl.protocol}//${marketUrl.host}`;
    app.use(
      csp({
        directives: {
          defaultSrc: [`'self'`],
          imgSrc: [`'self' data: ${imgsrc}`],
          styleSrc: [`'self' 'unsafe-inline'`],
          scriptSrc: [`'self'`],
          workerSrc: [`'self' blob:`],
        },
      })
    );
  }

  app.use(function(err, req, res, next) {
    log.error(err);
    res.status(500).send(err);
    next(err);
  });

  // serve the config file
  app.get('/config.js', function(req, res) {
    var data = JSON.stringify({
      // the following will be available in angular via the "MY_CONFIG" injectable

      authorization: req.headers.authorization,
      cdap: {
        standaloneWebsiteSDKDownload:
          uiSettings['standalone.website.sdk.download'] === 'true' || false,
        uiDebugEnabled: uiSettings['ui.debug.enabled'] === 'true' || false,
      },
      hydrator: {
        previewEnabled: cdapConfig['enable.preview'] === 'true',
      },
      marketUrl: cdapConfig['market.base.url'],
      securityEnabled: authAddress.enabled,
      isEnterprise: isModeProduction(),
      sandboxMode: process.env.NODE_ENV,
      authRefreshURL: cdapConfig['dashboard.auth.refresh.path'] || false,
    });

    res.header({
      'Content-Type': 'text/javascript',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.send('window.CDAP_CONFIG = ' + data + ';');
  });

  app.get('/ui-config.js', function(req, res) {
    var path = __dirname + '/config/cdap-ui-config.json';

    var fileConfig = {};

    fileConfig = fs.readFileSync(path, 'utf8');
    res.header({
      'Content-Type': 'text/javascript',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.send('window.CDAP_UI_CONFIG = ' + fileConfig + ';');
  });

  app.get('/ui-theme.js', function(req, res) {
    res.header({
      'Content-Type': 'text/javascript',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.send(`window.CDAP_UI_THEME = ${JSON.stringify(uiThemeConfig)};`);
  });

  /**
   * This is used to stream content from Market directly to CDAP
   * ie. download app from market, and publish to CDAP
   *
   * Query parameters:
   *    source: Link to the content to forward
   *    sourceMethod: HTTP method to obtain content (default to GET)
   *    target: CDAP API
   *    targetMethod: HTTP method for the CDAP API (default to POST)
   **/
  app.get('/forwardMarketToCdap', function(req, res) {
    var sourceLink = req.query.source,
      targetLink = req.query.target,
      sourceMethod = req.query.sourceMethod || 'GET',
      targetMethod = req.query.targetMethod || 'POST';

    sourceLink = urlhelper.constructUrl(cdapConfig, sourceLink, urlhelper.REQUEST_ORIGIN_MARKET);
    targetLink = urlhelper.constructUrl(cdapConfig, targetLink);
    var forwardRequestObject = {
      url: targetLink,
      method: targetMethod,
      headers: req.headers,
    };

    request({
      url: sourceLink,
      method: sourceMethod,
    })
      .on('error', function(e) {
        log.error('Error', e);
      })
      .pipe(request(forwardRequestObject))
      .on('error', function(e) {
        log.error('Error', e);
      })
      .pipe(res);
  });

  app.get('/downloadLogs', function(req, res) {
    var url = urlhelper.constructUrl(cdapConfig, decodeURIComponent(req.query.backendPath));
    var method = req.query.method || 'GET';
    log.info('Download Logs Start: ', url);
    var customHeaders;
    var requestObject = {
      method: method,
      url: url,
      rejectUnauthorized: false,
      requestCert: true,
      agent: false,
    };

    if (req.cookies['CDAP_Auth_Token']) {
      customHeaders = {
        authorization: 'Bearer ' + req.cookies['CDAP_Auth_Token'],
      };
    }

    if (customHeaders) {
      requestObject.headers = customHeaders;
    }

    var type = req.query.type;
    var responseHeaders = {
      'Cache-Control': 'no-cache, no-store',
    };

    try {
      request(requestObject)
        .on('error', function(e) {
          log.error('Error request logs: ', e);
        })
        .on('response', function(response) {
          // This happens when use tries to access the link directly when
          // no autorization token present
          if (response.statusCode === 200) {
            if (type === 'download') {
              var filename = req.query.filename;
              responseHeaders['Content-Disposition'] = 'attachment; filename=' + filename;
            } else {
              responseHeaders['Content-Type'] = 'text/plain';
            }

            res.set(responseHeaders);
          }
        })
        .pipe(res)
        .on('error', function(e) {
          log.error('Error downloading logs: ', e);
        });
    } catch (e) {
      log.error('Downloading logs failed, ', e);
    }
  });

  /*
    For now both login and accessToken APIs do the same thing.
    This is only for semantic differntiation. In the future ideally
    these endpoints will vary based on success failure conditions.
    (A 404 vs warning for login vs token)

  */
  app.post('/login', authentication);

  app.post('/accessToken', authentication);

  /*
    Handle POST requests made outside of the websockets from front-end.
    For now it handles file upload POST /namespaces/:namespace/apps API
  */
  app.post('/namespaces/:namespace/:path(*)', function(req, res) {
    var protocol, port;
    if (cdapConfig['ssl.external.enabled'] === 'true') {
      protocol = 'https://';
    } else {
      protocol = 'http://';
    }
    if (cdapConfig['ssl.external.enabled'] === 'true') {
      port = cdapConfig['router.ssl.server.port'];
    } else {
      port = cdapConfig['router.server.port'];
    }
    var headers = {};
    if (req.headers) {
      headers = req.headers;
    }

    var url = [
      protocol,
      cdapConfig['router.server.address'],
      ':',
      port,
      '/v3/namespaces/',
      req.param('namespace'),
      '/',
      req.param('path'),
    ].join('');

    var opts = {
      method: 'POST',
      url: url,
      headers: {
        'Content-Type': headers['content-type'],
      },
    };

    req
      .on('error', function(e) {
        log.error(e);
      })
      .pipe(request.post(opts))
      .on('error', function(e) {
        log.error(e);
      })
      .pipe(res)
      .on('error', function(e) {
        log.error(e);
      });
  });
  // serve static assets
  app.use('/assets', [
    express.static(DIST_PATH + '/assets'),
    function(req, res) {
      finalhandler(req, res)(false); // 404
    },
  ]);
  app.use('/cdap_assets', [
    express.static(CDAP_DIST_PATH + '/cdap_assets', getExpressStaticConfig()),
    function(req, res) {
      finalhandler(req, res)(false); // 404
    },
  ]);
  app.use('/dll_assets', [
    express.static(DLL_PATH, getExpressStaticConfig()),
    function(req, res) {
      finalhandler(req, res)(false);
    },
  ]);
  app.use('/login_assets', [
    express.static(LOGIN_DIST_PATH + '/login_assets', getExpressStaticConfig()),
    function(req, res) {
      finalhandler(req, res)(false); // 404
    },
  ]);
  app.use('/common_assets', [
    express.static(MARKET_DIST_PATH, {
      index: false,
    }),
    function(req, res) {
      finalhandler(req, res)(false); // 404
    },
  ]);
  app.get('/robots.txt', [
    function(req, res) {
      res.type('text/plain');
      res.send('User-agent: *\nDisallow: /');
    },
  ]);

  function authentication(req, res) {
    var opts = {
      auth: {
        user: req.body.username,
        password: req.body.password,
      },
      url: authAddress.get(),
    };
    request(opts, function(nerr, nres, nbody) {
      if (nerr || nres.statusCode !== 200) {
        var statusCode = (nres ? nres.statusCode : 500) || 500;
        res.status(statusCode).send(nbody);
      } else {
        res.send(nbody);
      }
    });
  }

  // CDAP-678, CDAP-8260 This is added for health check on node proxy.
  app.get('/status', function(req, res) {
    res.send(200, 'OK');
  });

  app.get('/login', [
    function(req, res) {
      if (!authAddress.get() || req.cookies.CDAP_Auth_Token) {
        res.redirect('/');
        return;
      }
      res.sendFile(LOGIN_DIST_PATH + '/login_assets/login.html');
    },
  ]);

  /*
    For now both login and accessToken APIs do the same thing.
    This is only for semantic differntiation. In the future ideally
    these endpoints will vary based on success failure conditions.
    (A 404 vs warning for login vs token)

  */
  app.post('/login', authentication);

  app.get('/backendstatus', [
    function(req, res) {
      var protocol, port;
      if (cdapConfig['ssl.external.enabled'] === 'true') {
        protocol = 'https://';
      } else {
        protocol = 'http://';
      }

      if (cdapConfig['ssl.external.enabled'] === 'true') {
        port = cdapConfig['router.ssl.server.port'];
      } else {
        port = cdapConfig['router.server.port'];
      }

      var link = [protocol, cdapConfig['router.server.address'], ':', port, '/v3/namespaces'].join(
        ''
      );

      // FIXME: The reason for doing this is here: https://issues.cask.co/browse/CDAP-9059
      // TL;DR - The source of this issue is because of large browser urls
      // which gets added to headers while making /backendstatus http call.
      // That is the reason we are temporarily stripping out referer from the headers.
      var headers = req.headers;
      delete headers.referer;
      request(
        {
          method: 'GET',
          url: link,
          rejectUnauthorized: false,
          requestCert: true,
          agent: false,
          headers: headers,
        },
        function(err, response) {
          if (err) {
            res.status(500).send(err);
          } else {
            res.status(response.statusCode).send('OK');
          }
        }
      ).on('error', function(err) {
        try {
          res.status(500).send(err);
        } catch (e) {
          log.error('Failed sending exception to client', e);
        }
        log.error(err);
      });
    },
  ]);

  app.get('/predefinedapps/:apptype', [
    function(req, res) {
      var apptype = req.params.apptype;
      var config = {};
      var fileConfig = {};
      var filesToMetadataMap = [];
      var filePath = __dirname + '/../templates/apps/predefined/config.json';
      try {
        fileConfig = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        filesToMetadataMap = fileConfig[apptype] || [];
        if (filesToMetadataMap.length === 0) {
          throw { code: 404 };
        }
        filesToMetadataMap = filesToMetadataMap.map(function(metadata) {
          return {
            name: metadata.name,
            description: metadata.description,
          };
        });
        res.send(filesToMetadataMap);
      } catch (e) {
        config.error = e.code;
        config.message = 'Error reading template - ' + apptype;
        log.debug(config.message);
        res.status(404).send(config);
      }
    },
  ]);

  app.get('/predefinedapps/:apptype/:appname', [
    function(req, res) {
      var apptype = req.params.apptype;
      var appname = req.params.appname;
      var filesToMetadataMap = [];
      var appConfig = {};

      var dirPath = __dirname + '/../templates/apps/predefined/';
      var filePath = dirPath + 'config.json';
      var config = {};
      var fileConfig = {};
      try {
        fileConfig = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        filesToMetadataMap = fileConfig[apptype] || [];
        filesToMetadataMap = filesToMetadataMap.filter(function(metadata) {
          if (metadata.name === appname) {
            return metadata.file;
          }
        });
        if (filesToMetadataMap.length === 0) {
          throw { code: 404 };
        }
        appConfig = JSON.parse(fs.readFileSync(dirPath + '/' + filesToMetadataMap[0].file));
        res.send(appConfig);
      } catch (e) {
        config.error = e.code;
        config.message = 'Error reading template - ' + appname + ' of type - ' + apptype;
        log.debug(config.message);
        res.status(404).send(config);
      }
    },
  ]);

  app.get('/validators', [
    function(req, res) {
      var filePath = __dirname + '/../templates/validators/validators.json';
      var config = {};
      var validators = {};

      try {
        validators = JSON.parse(fs.readFileSync(filePath));
        res.send(validators);
      } catch (e) {
        config.error = e.code;
        config.message = 'Error reading validators.json';
        log.debug(config.message);
        res.status(404).send(config);
      }
    },
  ]);

  /**
   * This is right now purely for testing purposes. This helps us
   * update the theme from API and test different theming scenarios.
   *
   * This won't be for production as we don't persist this state anywhere.
   * In the future if we alow the user to change the theme from UI this API could
   * be used and we need to persist this information somewhere.
   */
  app.post('/updateTheme', function(req, res) {
    const uiThemePath = req.body.uiThemePath;
    if (!uiThemePath) {
      return res.status(500).send('UnKnown theme file. Please make sure the path is valid');
    }
    try {
      uiThemeConfig = extractUITheme(cdapConfig, uiThemePath);
    } catch (e) {
      return res
        .status(500)
        .send(
          'Error parsing theme file. Please make sure the path and the file contents are valid'
        );
    }
    res.send('Theme updated');
  });

  // any other path, serve index.html
  app.all(
    ['/pipelines', '/pipelines*'],
    [
      function(req, res) {
        // BCookie is the browser cookie, that is generated and will live for a year.
        // This cookie is always generated to provide unique id for the browser that
        // is being used to interact with the CDAP backend.
        var date = new Date();
        date.setDate(date.getDate() + 365); // Expires after a year.
        if (!req.cookies.bcookie) {
          res.cookie('bcookie', uuidV4(), { expires: date });
        } else {
          res.cookie('bcookie', req.cookies.bcookie, { expires: date });
        }
        res.sendFile(DIST_PATH + '/hydrator.html');
      },
    ]
  );
  app.all(
    ['/metadata', '/metadata*'],
    [
      function(req, res) {
        // BCookie is the browser cookie, that is generated and will live for a year.
        // This cookie is always generated to provide unique id for the browser that
        // is being used to interact with the CDAP backend.
        var date = new Date();
        date.setDate(date.getDate() + 365); // Expires after a year.
        if (!req.cookies.bcookie) {
          res.cookie('bcookie', uuidV4(), { expires: date });
        } else {
          res.cookie('bcookie', req.cookies.bcookie, { expires: date });
        }
        res.sendFile(DIST_PATH + '/tracker.html');
      },
    ]
  );

  app.all(
    ['/logviewer', '/logviewer*'],
    [
      function(req, res) {
        // BCookie is the browser cookie, that is generated and will live for a year.
        // This cookie is always generated to provide unique id for the browser that
        // is being used to interact with the CDAP backend.
        var date = new Date();
        date.setDate(date.getDate() + 365); // Expires after a year.
        if (!req.cookies.bcookie) {
          res.cookie('bcookie', uuidV4(), { expires: date });
        } else {
          res.cookie('bcookie', req.cookies.bcookie, { expires: date });
        }
        res.sendFile(DIST_PATH + '/logviewer.html');
      },
    ]
  );

  app.all(
    ['/', '/cdap', '/cdap*'],
    [
      function(req, res) {
        res.sendFile(CDAP_DIST_PATH + '/cdap_assets/cdap.html');
      },
    ]
  );

  return app;
}
