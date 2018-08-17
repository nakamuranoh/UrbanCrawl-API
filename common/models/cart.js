/*
 * Copyright 2018. Akamai Technologies, Inc
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var app = require('../../server/server');

var unitprice;
var moment = require('moment');

module.exports = function(Cart) {
  var returnCart = function(userid, cb) {
    Cart.find({where: {userid: userid},
      fields: {cityid: true, quantity: true, totalprice: true, thumburl: true}},
      function(err, result) {
        if (!err) {
          cb(null, result);
        } else {
          console.log('Cart : returnCart : error: Cart.find error: ', err);
          var error = new Error();
          error.message = 'Something went wrong and we couldn\'t return the cart items. Write to us if this persists';
          error.errorCode = 'OTHER_ERROR';
          error.status = 500;
          cb(error, null);
        }
      });
  };

  var _actionCode = Object.freeze({ADD_TO_CART: 1, GET_CART: 2, CHECKOUT: 3});

  // Function to verify the token passed to it
  var verifyTokenAndProceed = function(token, body, actionCode, cb) {
    var Token = app.models.Token;
    console.log('Account : Get Account : Sent Token : ', token);
    Token.find({where: {token: token}}, function(err, tokenFindResult) {
      if (!err) {
        if (tokenFindResult.length > 0) {
          tokenFindResult = tokenFindResult[0];
          var tokenIssuedDate = moment(tokenFindResult.createddate);
          var dateNow = moment();
          var diffInSecs = dateNow.diff(tokenIssuedDate) / 1000;

          var userId = tokenFindResult.userid;

          if (diffInSecs <= tokenFindResult.ttl) {
            // Token is still valid
            switch (actionCode) {
              case _actionCode.ADD_TO_CART:
                addItemToCart(body, userId, cb);
                break;
              case _actionCode.GET_CART:
                returnCart(userId, cb);
                break;
              case _actionCode.CHECKOUT:
                var Order = app.models.Order;
                Order.checkout(userId, cb);
                break;
              default:
                console.log('Cart : verifyTokenAndProceed : error: Operation Not Defined');
                var error = new Error();
                error.message = 'Operation Not Defined';
                error.errorCode = 'OTHER_ERROR';
                error.status = 500;
                cb(error, null);
            }
          } else {
          // The token wasn't found, return that token was invalid
            console.log('Cart : verifyTokenAndProceed : error: Token Expired');
            var error = new Error();
            error.message = 'Token Expired';
            error.errorCode = 'AUTH_EXPIRED';
            error.status = 403;
            cb(error, null);
          }
        } else {
        // Token has expired
          console.log('Cart : verifyTokenAndProceed : error: Token Expired (Token.find found 0 tokens): ');
          var error = new Error();
          error.message = 'Token Invalid';
          error.errorCode = 'AUTH_INVALID';
          error.status = 403;
          cb(error, null);
        }
        return;
      } else {
        console.log('Cart : verifyTokenAndProceed : error: Token Expired (Token.find err): ', err);
        var error = new Error();
        error.message = 'Incorrect Authentication';
        error.errorCode = 'AUTH_INVALID';
        error.status = 403;
        cb(error, null);
        return;
      }
    });
  };

  // --------------------- ADD TO, OR UPDATE CART ------------
  // {
  // "cityid": 44,
  // "qty":2
  // }
  Cart.addToCart = function(version, body, req, cb) {
    console.log('#### AUTH HEADER', version.apiVersion);
    switch (version.apiVersion) {
      case 'v2':
        if (body === undefined ||
        body.cityid === undefined ||
        body.qty === undefined) {
          console.log('Cart : addToCart : error: Supplied parameters are insufficient.');
          var error = new Error();
          error.message = 'Supplied parameters are insufficient.';
          error.errorCode = 'INSUFFICIENT_PARAMETERS_SUPPLIED';
          error.status = 400;
          cb(error, null);
          return;
        }

        var sentToken = req.headers.authorization;
        if (sentToken === undefined) {
          console.log('Cart : addToCart : error: Authorization Required');
          var error = new Error();
          error.message = 'Authorization Required';
          error.status = 401;
          error.errorCode = 'AUTH_REQUIRED';
          cb(error, null);
          return;
        } else {
          // try to verify token
          verifyTokenAndProceed(sentToken, body, _actionCode.ADD_TO_CART, cb);
        }
        break;
      default:
        console.log('Cart : addToCart : error: invalid API version');
        var error = new Error();
        error.message = 'You must supply a valid api version';
        error.errorCode = 'INVALID_API_VERSION';
        error.status = 400;
        cb(error, null);
    }
  };

  Cart.remoteMethod(
      'addToCart', {
        http: {
          path: '/',
          verb: 'post',
        },
        accepts: [
          {
            arg: 'version',
            type: 'object',
            description: 'API version eg. v1, v2, etc.',
            http: function(context) {
              return {apiVersion: context.req.apiVersion};
            },
          },
          {
            arg: 'items',
            type: 'any',
            http: {
              source: 'body',
            },
          },
          {
            arg: 'request',
            type: 'object',
            http: {
              source: 'req',
            },
          },
        ],
        returns: {
          arg: 'items',
          description: 'Returns an HTTP 200, and the items in cart for this user, if everything goes well',
          type: 'any',
        },
      }
  );

  // Adds the item to cart if the token was valid
  var addItemToCart = function(body, userid, cb) {
    // Trying to get price and other details of the city the user selected
    var City = app.models.City;

    City.find({
      where: {id: body.cityid},
      fields: {id: true, thumburl: true, tour_price: true},
    },  function(err, cityResult) {
      // If the sent cityId was found, let's process
      if (!err) {
        // Check if the sent city is already in the cart from the same user, to increment it
        if (cityResult.length > 0) {
          unitprice = cityResult[0].tour_price;
          Cart.find({
            where: {cityid: body.cityid, userid: userid},
          }, function(err, cartResult) {
            // The item exists, update it's details
            if (!err) {
              if (cartResult.length > 0) {
                updateCart(body, userid, unitprice, cb);
              } else {
                console.log('CART: ADDING NEW ITEM');
                var dateNow = moment(Date.now()).format('YYYY-MM-DD HH:mm:ss');
                Cart.create(
                  {cityid: body.cityid, userid: userid, thumburl: cityResult[0].thumburl,
                    unitprice: unitprice, quantity: body.qty,
                    totalprice: (unitprice * body.qty), createddate: dateNow,
                    updatedate: dateNow},
                  function(err, createResult) {
                    if (!err) {
                      console.log('CART: Create Result: ', createResult);
                      // return a total number of items for this user
                      returnCart(userid, cb);
                    } else {
                      console.log('Cart : addItemToCart : error: Cart.create error: ', err);
                      var error = new Error();
                      error.message = 'Something went wrong and we couldn\'t add a new item. Write to us if this persists';
                      error.errorCode = 'OTHER_ERROR';
                      error.status = 500;
                      cb(error, null);
                    }
                  });
              }
            } else {
              console.log('Cart : addItemToCart : error: Cart.find error: ', err);
              var error = new Error();
              error.message = 'Something went wrong and we couldn\'t fulfil this request. Write to us if this persists';
              error.errorCode = 'OTHER_ERROR';
              error.status = 500;
              cb(error, null);
            }
          });
        } else {
          console.log('Cart : addItemToCart : error: City not found');
          var error = new Error();
          error.message = 'City not found';
          error.errorCode = 'RESOURCE_NOT_FOUND';
          error.status = 404;
          cb(error, null);
        }
      } else {
        console.log('Cart : addItemToCart : error: City.find err: ', err);
        var error = new Error();
        error.message = 'Something went wrong and we couldn\'t fulfil this request. Write to us if this persists';
        error.errorCode = 'OTHER_ERROR';
        error.status = 500;
        cb(error, null);
      }
    });
  };

  var updateCart = function(body, userid, unitprice, cb) {
    if (body.qty > 0) {
      var dateNow = moment(Date.now()).format('YYYY-MM-DD HH:mm:ss');
      Cart.updateAll({cityid: body.cityid, userid: userid},
        {quantity: body.qty, totalprice: unitprice * body.qty,
          updatedate: dateNow},
          function(err, info) {
            if (!err) {
              returnCart(userid, cb);
            } else {
              console.log('Cart : updateCart : error: City.updateAll err: ', err);
              var error = new Error();
              error.message = 'Something went wrong and we couldn\'t update the cart. Write to us if this persists';
              error.errorCode = 'OTHER_ERROR';
              error.status = 500;
              cb(error, null);
            }
          });
    } else {
      // quantity 0, delete the item
      Cart.destroyAll({cityid: body.cityid, userid: userid},
        function(err, result) {
          if (!err) {
            if (result.count >= 1) {
              // respond with updated cart
              returnCart(userid, cb);
            } else {
              console.log('Cart : updateCart : error: City.destroyAll -> Nothing was deleted: ');
              var error = new Error();
              error.message = 'Something went wrong and we couldn\'t fulfil this request. Write to us if this persists';
              error.errorCode = 'OTHER_ERROR';
              error.status = 500;
              cb(error, null);
            }
          } else {
            console.log('Cart : updateCart : error: City.destroyAll err: ', err);
            var error = new Error();
            error.message = 'Something went wrong and we couldn\'t fulfil this request. Write to us if this persists';
            error.errorCode = 'OTHER_ERROR';
            error.status = 500;
            cb(error, null);
          }
        });
    }
  };

// ---------------- Show all cart items ----------

  Cart.getCart = function(version, req, cb) {
    switch (version.apiVersion) {
      case 'v2':
        var sentToken = req.headers.authorization;
        if (sentToken === undefined) {
          var error = new Error();
          error.message = 'Authorization Required';
          error.status = 401;
          error.errorCode = 'AUTH_REQUIRED';
          cb(error, null);
          return;
        } else {
          // try to verify token
          verifyTokenAndProceed(sentToken, null, _actionCode.GET_CART, cb);
        }
        break;
      default:
        console.log('Cart : getCart : error: Invalid API version: ');
        var error = new Error();
        error.message = 'You must supply a valid api version';
        error.errorCode = 'INVALID_API_VERSION';
        error.status = 400;
        cb(error, null);
    }
  };

  Cart.remoteMethod(
      'getCart', {
        http: {
          path: '/',
          verb: 'get',
        },
        accepts: [
          {
            arg: 'version',
            type: 'object',
            description: 'API version eg. v1, v2, etc.',
            http: function(context) {
              return {apiVersion: context.req.apiVersion};
            },
          },
          {
            arg: 'request',
            type: 'object',
            http: {
              source: 'req',
            },
          },
        ],
        returns: {
          arg: 'item',
          description: 'Returns an HTTP 200, and all the cart items, if everything goes well',
          type: 'any',
        },
      }
  );

// ---------------- Checkout ----------

  Cart.checkout = function(version, req, cb) {
    switch (version.apiVersion) {
      case 'v2':
        var sentToken = req.headers.authorization;
        if (sentToken === undefined) {
          console.log('Cart : checkout : error: Token was not sent');
          var error = new Error();
          error.message = 'Authorization Required';
          error.status = 401;
          error.errorCode = 'AUTH_REQUIRED';
          cb(error, null);
          return;
        } else {
          // try to verify token
          verifyTokenAndProceed(sentToken, null, _actionCode.CHECKOUT, cb);
        }
        break;
      default:
        console.log('Cart : checkout : error: City.destroyAll err: ', err);
        var error = new Error();
        error.message = 'You must supply a valid api version';
        error.errorCode = 'INVALID_API_VERSION';
        error.status = 400;
        cb(error, null);
    }
  };

  Cart.remoteMethod(
      'checkout', {
        http: {
          path: '/checkout',
          verb: 'put',
        },
        accepts: [
          {
            arg: 'version',
            type: 'object',
            description: 'API version eg. v1, v2, etc.',
            http: function(context) {
              return {apiVersion: context.req.apiVersion};
            },
          },
          {
            arg: 'request',
            type: 'object',
            http: {
              source: 'req',
            },
          },
        ],
        returns: {
          arg: 'items',
          description: 'Returns an HTTP 200, and the items in cart for this user, if everything goes well',
          type: 'any',
        },
      }
  );
};
