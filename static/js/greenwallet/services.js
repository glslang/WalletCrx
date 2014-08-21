angular.module('greenWalletServices', [])
.factory('focus', ['$rootScope', '$timeout', 'cordovaReady', function ($rootScope, $timeout, cordovaReady) {
   return function(name) {
        $timeout(function (){
            $rootScope.$broadcast('focusOn', name);
            /* doesn't work very well
            if (window.cordova) {
                cordovaReady(function() {
                    window.plugins.SoftKeyboard.show();
                })();
            } */
        });
   }
}]).factory('crypto', ['cordovaReady', '$q', function(cordovaReady, $q) {
    var pbkdf2_iterations = 10; //Not ideal, but limitations of using javascript
    var cryptoService = {};
    cryptoService.encrypt = function(data, password) {
        if (window.cordova && cordova.platformId == 'ios') {
            var deferred = $q.defer();
            cordovaReady(function() {
                cordova.exec(function(param) {
                    deferred.resolve(param);
                }, function(fail) {
                    console.log('cryptoService.encrypt failed: ' + fail)
                    deferred.resolve();
                }, "AES", "encrypt", [data, password]);
            })();
            return deferred.promise;
        } else {
            var salt = Bitcoin.CryptoJS.lib.WordArray.random(16);
            var key256Bits = Bitcoin.CryptoJS.PBKDF2(password, salt, {
                    keySize: 256/32, iterations: pbkdf2_iterations});
            var encrypted = Bitcoin.CryptoJS.AES.encrypt(data, key256Bits, {
                    mode: Bitcoin.CryptoJS.mode.CBC,
                    padding: Bitcoin.CryptoJS.pad.Iso10126,
                    iv: salt});
            return $q.when(Bitcoin.CryptoJS.enc.Base64.stringify(salt.concat(encrypted.ciphertext)));
        }
    }
    cryptoService.decrypt = function(data, password) {
        if (window.cordova && cordova.platformId == 'ios') {
            var deferred = $q.defer();
            cordovaReady(function() {
                cordova.exec(function(param) {
                    deferred.resolve(param);
                }, function(fail) {
                    console.log('cryptoService.encrypt failed: ' + fail)
                    deferred.resolve();
                }, "AES", "decrypt", [data, password]);
            })();
            return deferred.promise;
        } else {
            //iso10126 with pbkdf2_iterations iterations
            try {
                var parsed_data = Bitcoin.CryptoJS.enc.Base64.parse(data);
                var salt = Bitcoin.CryptoJS.lib.WordArray.create(parsed_data.words.splice(0, 4));
                parsed_data.sigBytes -= 16;
                var key256Bits = Bitcoin.CryptoJS.PBKDF2(password, salt, {
                        keySize: 256/32, iterations: pbkdf2_iterations});
                var decoded = Bitcoin.CryptoJS.AES.decrypt(
                        Bitcoin.CryptoJS.lib.CipherParams.create({ciphertext: parsed_data}),
                        key256Bits, {
                            mode: Bitcoin.CryptoJS.mode.CBC,
                            padding: Bitcoin.CryptoJS.pad.Iso10126,
                            iv: salt});
                if (decoded != null && decoded.sigBytes > 0) {
                    return $q.when(Bitcoin.CryptoJS.enc.Utf8.stringify(decoded));
                };
            } catch (e) {
                console.log(e);
            }
            return $q.when();
        }
    }
    return cryptoService;
}]).factory('autotimeout', ['$timeout', '$document', function($timeout, $document) {
    var timeoutms = 1000;
    var autotimeoutService = {promise: false, callbacks: []};

    var notifyObservers = function(){
        angular.forEach(autotimeoutService['callbacks'], function(callback){
            callback();
        });
    };
    var reset = function(amountminutes) {
        autotimeoutService.left = amountminutes * 1000 * 60;
    };

    var countdown = function() {
        if (autotimeoutService.left <= 0) {
            autotimeoutService.stop();
            var is_chrome_app = window.chrome && chrome.storage;
            if (is_chrome_app) {
                chrome.runtime.reload();
            } else {
                window.location.reload();
            }
        } else {
            autotimeoutService.left = autotimeoutService.left - timeoutms;
            notifyObservers();
            autotimeoutService.promise = $timeout(countdown, timeoutms);
        }
    };

    autotimeoutService.registerObserverCallback = function(callback){
        autotimeoutService['callbacks'].push(callback);
    };

    autotimeoutService.stop = function() {
        $document.find('body').off('mousemove keydown DOMMouseScroll mousewheel mousedown touchstart');
        if (autotimeoutService.promise) {
            $timeout.cancel(autotimeoutService.promise);
            autotimeoutService.promise = false;
        }
    };

    autotimeoutService.start = function(amountminutes) {
        autotimeoutService.stop();
        if (amountminutes != 0) {
            reset(amountminutes);
            autotimeoutService.promise = $timeout(countdown, timeoutms);
            $document.find('body').on('mousemove keydown DOMMouseScroll mousewheel mousedown touchstart', function() {
                try {
                    reset(amountminutes);
                } catch(err) {
                    // already logged out
                    console.log(err);
                    //autotimeoutService.stop();
                }
            });
        }
    };

    return autotimeoutService;

}]).factory('wallets', ['$q', '$rootScope', 'tx_sender', '$location', 'notices', '$modal', 'focus', 'crypto', 'gaEvent', 'storage', 'mnemonics', 'addressbook', 'autotimeout', 'social_types', 'sound', '$interval', '$timeout',
        function($q, $rootScope, tx_sender, $location, notices, $modal, focus, crypto, gaEvent, storage, mnemonics, addressbook, autotimeout, social_types, sound, $interval, $timeout) {
    var walletsService = {};
    var handle_double_login = function(retry_fun) {
        return $modal.open({
            templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_logout_other_session.html'
        }).result.then(function() {
            return retry_fun();
        });
    }
    walletsService.requireWallet = function($scope, dontredirect) {
        if (!$scope.wallet.hdwallet && !$scope.wallet.trezor_dev && !$scope.wallet.btchip) {
            if (!dontredirect) {
                var location = '/?redir=' + $location.path();
                var search = '';
                for (var key in $location.search()) {
                    if (i > 0) search += '&';
                    search += key + '=' + encodeURIComponent($location.search()[key]);
                }
                if (search) {
                    location += encodeURIComponent('?' + search);
                }
                $location.url(location);
                $scope.processWalletVars();  // update payment values with redir value
            }
            return false;
        }
        return true;
    };
    walletsService.updateAppearance = function($scope, key, value) {
        var oldValue = $scope.wallet.appearance[key];
        $scope.wallet.appearance[key] = value;
        return tx_sender.call('http://greenaddressit.com/login/set_appearance', JSON.stringify($scope.wallet.appearance)).catch(function(e) {
            $scope.wallet.appearance[key] = oldValue;
            return $q.reject(e);
        });
    }
    var openInitialPage = function(wallet, has_txs) {
        if ($location.search().redir) {
            $location.url($location.search().redir);
        } else if (!has_txs) {
            $location.path('/receive');
        } else if (window.IS_MOBILE || wallet.send_to_receiving_id || wallet.send_to_payment_request) {
            $location.path('/send');
        } else {
            $location.url('/info');
        }
    };
    walletsService._login = function($scope, hdwallet, mnemonic, signup, logout, path_seed, path) {
        var d = $q.defer(), that = this;
        tx_sender.login(logout).then(function(data) {
            if (data) {
                if (window.disableEuCookieComplianceBanner) {
                    disableEuCookieComplianceBanner();
                }
                tx_sender.wallet = $scope.wallet;
                $scope.wallet.hdwallet = hdwallet;
                $scope.wallet.trezor_dev = tx_sender.trezor_dev;
                $scope.wallet.btchip = tx_sender.btchip;
                $scope.wallet.mnemonic = mnemonic;
                if (data.last_login) {
                    $scope.wallet.last_login = data.last_login;
                }
                try {
                    $scope.wallet.appearance = JSON.parse(data.appearance);
                    if ($scope.wallet.appearance.constructor !== Object) $scope.wallet.appearance = {};
                } catch(e) {
                    $scope.wallet.appearance = {};
                }
                if (!('sound' in $scope.wallet.appearance)) {
                    $scope.wallet.appearance.sound = true;
                }
                if (!('altimeout' in $scope.wallet.appearance)) {
                    $scope.wallet.appearance.altimeout = 20;
                }
                notices.makeNotice('success', gettext('Logged in!'));
                sound.play(BASE_URL + "/static/sound/coinreceived.mp3", $scope);
                autotimeout.start($scope.wallet.appearance.altimeout);
                $scope.wallet.privacy = data.privacy;
                $scope.wallet.limits = data.limits;
                $scope.wallet.unit = $scope.wallet.appearance.unit || 'mBTC';
                $scope.wallet.cache_password = data.cache_password;
                $scope.wallet.fiat_exchange = data.exchange;
                $scope.wallet.receiving_id = data.receiving_id;
                $scope.wallet.expired_deposits = data.expired_deposits;
                $scope.wallet.nlocktime_blocks = data.nlocktime_blocks;
                if (path) {
                    $scope.wallet.gait_path = path;
                } else if (path_seed) {
                    $scope.wallet.gait_path_seed = path_seed;
                    $scope.wallet.gait_path = mnemonics.seedToPath(path_seed);
                } else {
                    $scope.wallet.gait_path = data.gait_path;
                }
                if (data.gait_path !== $scope.wallet.gait_path) {
                    tx_sender.call('http://greenaddressit.com/login/set_gait_path', $scope.wallet.gait_path).catch(function(err) {
                        if (err.uri != 'http://api.wamp.ws/error#NoSuchRPCEndpoint') {
                            notices.makeNotice('error', 'Please contact support (reference "sgp_error ' + err.desc + '")');
                        } else {
                            $scope.wallet.old_server = true;
                        }
                    });
                }
                if (!signup) {  // don't change URL on initial login in signup
                    openInitialPage($scope.wallet, data.has_txs);
                }
                $rootScope.$broadcast('login');
            } else if (!signup) {  // signup has its own error handling
                d.reject();
                return;
            }
            d.resolve(data);
        }).catch(function(e) { d.reject(e); });
        return d.promise.catch(function(err) {
            if (err && err.uri == 'http://greenaddressit.com/error#doublelogin') {
                return handle_double_login(function() {
                    return that.login($scope, hdwallet, mnemonic, signup, true, path_seed);
                });
            } else {
                notices.makeNotice('error', gettext('Login failed') + (err && err.desc && (': ' + err.desc) || ''));
                return $q.reject(err);
            }
        });
    }
    walletsService.login = function($scope, hdwallet, mnemonic, signup, logout, path_seed) {
        tx_sender.hdwallet = hdwallet;
        return this._login($scope, hdwallet, mnemonic, signup, logout, path_seed);
    };
    walletsService.login_trezor = function($scope, trezor_dev, path, signup, logout) {
        tx_sender.trezor_dev = trezor_dev;
        var that = this;
        return trezor_dev.getPublicKey([]).then(function(pubkey) {
            var hdwallet = new Bitcoin.HDWallet();
            hdwallet.network = cur_net;
            hdwallet.pub = new Bitcoin.ECPubKey(Bitcoin.convert.hexToBytes(pubkey.message.node.public_key), true);
            tx_sender.trezor_address = hdwallet.pub.getAddress(Bitcoin.network[cur_net].addressVersion).toString();
            hdwallet.chaincode = Bitcoin.convert.hexToBytes(pubkey.message.node.chain_code);
            tx_sender.hdwallet = hdwallet;
            return that._login($scope, hdwallet, undefined, signup, logout, undefined, path);
        });
    };
    walletsService.login_btchip = function($scope, btchip, btchip_pubkey, logout) {
        tx_sender.btchip = btchip;
        tx_sender.btchip_address = btchip_pubkey.bitcoinAddress.value;
        var hdwallet = new Bitcoin.HDWallet();
        hdwallet.network = cur_net;
        hdwallet.pub = new Bitcoin.ECPubKey(Bitcoin.convert.hexToBytes(btchip_pubkey.publicKey.toString(HEX)));
        hdwallet.chaincode = Bitcoin.convert.hexToBytes(btchip_pubkey.chainCode.toString(HEX));
        tx_sender.hdwallet = hdwallet;
        return this._login($scope, hdwallet, undefined, false, logout, undefined, undefined);
    };
    walletsService.loginWatchOnly = function($scope, token_type, token, logout) {
        var promise = tx_sender.loginWatchOnly(token_type, token, logout), that = this;
        promise = promise.then(function(json) {
            if (window.disableEuCookieComplianceBanner) {
                disableEuCookieComplianceBanner();
            }
            var data = JSON.parse(json);
            tx_sender.wallet = $scope.wallet;
            var hdwallet = new Bitcoin.HDWallet();
            hdwallet.network = cur_net;
            hdwallet.pub = new Bitcoin.ECPubKey(Bitcoin.convert.hexToBytes(data.public_key));
            hdwallet.chaincode = Bitcoin.convert.hexToBytes(data.chain_code);
            $scope.wallet.hdwallet = hdwallet;
            try {
                $scope.wallet.appearance = JSON.parse(data.appearance);
                if ($scope.wallet.appearance.constructor !== Object) $scope.wallet.appearance = {};
            } catch(e) {
                $scope.wallet.appearance = {};
            }
            if (!('sound' in $scope.wallet.appearance)) {
                $scope.wallet.appearance.sound = true;
            }
            if (!('altimeout' in $scope.wallet.appearance)) {
                $scope.wallet.appearance.altimeout = 20;
            }

            autotimeout.start($scope.wallet.appearance.altimeout);
            $scope.wallet.unit = $scope.wallet.appearance.unit || 'mBTC';

            $scope.wallet.cache_password = data.cache_password;
            $scope.wallet.fiat_exchange = data.exchange;
            $scope.wallet.receiving_id = data.receiving_id;
            if (data.has_txs) {
                $location.url('/info/');
            } else {
                $location.url('/receive/');
            }
            $rootScope.$broadcast('login');
        }, function(err) {
            if (err.uri == 'http://greenaddressit.com/error#doublelogin') {
                return handle_double_login(function() {
                    return that.loginWatchOnly($scope, token_type, token, true);
                });
            } else {
                return $q.reject(err);
            }
        });
        return promise;
    };
    walletsService.getTransactions = function($scope, notifydata, query, sorting, date_range) {
        return addressbook.load($scope).then(function() {
            return walletsService._getTransactions($scope, notifydata, null, query, sorting, date_range);
        });
    };
    var parseSocialDestination = function(social_destination) {
        try {
            var data = JSON.parse(social_destination);
            if (data.type == 'voucher') return gettext('Voucher');
            else return social_destination;
        } catch (e) {
            return social_destination;
        }
    };
    walletsService._getTransactions = function($scope, notifydata, page_id, query, sorting, date_range) {
        var transactions_key = $scope.wallet.receiving_id + 'transactions';
        var d = $q.defer();
        $rootScope.is_loading += 1;
        var unclaimed = [];

        if (sorting) {
            var sort_by = sorting.order_by;
            if (sorting.reversed) { sort_by = '-'+sort_by; }
        } else {
            var sort_by = null;
        }
        sorting = sorting || {order_by: 'ts', reversed: true};
        var end = date_range && date_range[1] && new Date(date_range[1]);
        if (end) end.setDate(end.getDate() + 1);
        var date_range_iso = date_range && [date_range[0] && date_range[0].toISOString(),
                                            end && end.toISOString()];
        var call = tx_sender.call('http://greenaddressit.com/txs/get_list_v2',
            page_id, query, sort_by, date_range_iso);

        call.then(function(data) {
            var retval = [];
            var any_unconfirmed_seen = false;

            for (var i = 0; i < data.list.length; i++) {
                var tx = data.list[i], inputs = [], outputs = [];
                var num_confirmations = data.cur_block - tx.block_height + 1;

                any_unconfirmed_seen = any_unconfirmed_seen || (num_confirmations < 6 && !tx.double_spent_by);

                var value = new Bitcoin.BigInteger('0'),
                    in_val = new Bitcoin.BigInteger('0'), out_val = new Bitcoin.BigInteger('0'),
                    redeemable_value = new Bitcoin.BigInteger('0'), sent_back_from, redeemable_unspent = false,
                    pubkey_pointer, sent_back = false, from_me = false, tx_social_destination, tx_social_value;
                var negative = false, positive = false, unclaimed = false, external_social = false;
                for (var j = 0; j < tx.eps.length; j++) {
                    var ep = tx.eps[j];
                    if (ep.is_relevant && !ep.is_credit) from_me = true;
                }
                for (var j = 0; j < tx.eps.length; j++) {
                    var ep = tx.eps[j];
                    if (ep.is_relevant) {
                        if (ep.is_credit) {
                            var bytes = Bitcoin.base58.decode(ep.ad);
                            var version = bytes[0];
                            var _external_social = version != Bitcoin.network[cur_net].p2shVersion;
                            external_social = external_social || _external_social;

                            if (ep.social_destination && external_social) {
                                pubkey_pointer = ep.pubkey_pointer;
                                if (!from_me) {
                                    redeemable_value = redeemable_value.add(new Bitcoin.BigInteger(ep.value));
                                    sent_back_from = parseSocialDestination(ep.social_destination);
                                    redeemable_unspent = redeemable_unspent || !ep.is_spent;
                                }
                            } else {
                                value = value.add(new Bitcoin.BigInteger(ep.value));
                                ep.nlocktime = true;
                            }
                        }
                        else {
                            value = value.subtract(new Bitcoin.BigInteger(ep.value));
                        }
                    }
                    if (ep.is_credit) {
                        outputs.push(ep);
                        out_val = out_val.add(new Bitcoin.BigInteger(ep.value));
                    } else { inputs.push(ep); in_val = in_val.add(new Bitcoin.BigInteger(ep.value)); }
                }
                if (value.compareTo(new Bitcoin.BigInteger('0')) > 0 || redeemable_value.compareTo(new Bitcoin.BigInteger('0')) > 0) {
                    if (notifydata && (tx.txhash == notifydata.txhash)) {
                        notifydata = undefined;
                        notices.makeNotice('success', gettext('Bitcoin transaction received!'));
                        sound.play(BASE_URL + "/static/sound/coinreceived.mp3", $scope);
                    }
                    positive = true;
                    if (redeemable_value.compareTo(new Bitcoin.BigInteger('0')) > 0) {
                        var description = gettext('Back from ') + sent_back_from;
                    } else {
                        var description = gettext('From ');
                        var addresses = [];
                        for (var j = 0; j < tx.eps.length; j++) {
                            var ep = tx.eps[j];
                            if (!ep.is_credit && !ep.is_relevant) {
                                if (ep.social_source) {
                                    if (addresses.indexOf(ep.social_source) == -1) {
                                        addresses.push(ep.social_source);
                                    }
                                } else {
                                    var ad = addressbook.reverse[ep.ad] || ep.ad;
                                    if (addresses.indexOf(ad) == -1) {
                                        addresses.push(ad);
                                    }
                                }
                            }
                        }
                        description += addresses.length ? addresses[0] : '';
                        if (addresses.length > 1) {
                            description += ', ...';
                        }
                    }
                } else {
                    negative = value.compareTo(new Bitcoin.BigInteger('0')) < 0;
                    var addresses = [];
                    var description = gettext('To ');
                    for (var j = 0; j < tx.eps.length; j++) {
                        var ep = tx.eps[j];
                        if (ep.is_credit && (!ep.is_relevant || ep.social_destination)) {
                            if (ep.social_destination && ep.social_destination_type != social_types.PAYMENTREQUEST) {
                                try {
                                    tx_social_destination = JSON.parse(ep.social_destination);
                                    tx_social_value = ep.value;
                                } catch (e) {
                                }
                                pubkey_pointer = ep.pubkey_pointer;
                                var bytes = Bitcoin.base58.decode(ep.ad);
                                var version = bytes[0];
                                var _external_social = version != Bitcoin.network[cur_net].p2shVersion;
                                external_social = external_social || _external_social;
                                if (!ep.is_spent && ep.is_relevant) {
                                    unclaimed = true;
                                    addresses.push(parseSocialDestination(ep.social_destination));
                                } else if (!ep.is_relevant && external_social) {
                                    sent_back = true;
                                    addresses.push(ep.ad);
                                } else {
                                    addresses.push(parseSocialDestination(ep.social_destination));
                                }
                            } else if (ep.social_destination && ep.social_destination_type == social_types.PAYMENTREQUEST) {
                                if (addresses.indexOf(ep.social_destination) == -1) {
                                    addresses.push(ep.social_destination);
                                }
                            } else {
                                var ad = addressbook.reverse[ep.ad] || ep.ad;
                                addresses.push(ad);
                            }
                        }
                    }

                    if(sent_back) {
                        description = gettext('Sent back to ')
                    }
                    if (!addresses.length) {
                        description = gettext('Re-deposited');
                    } else {
                        description += addresses.join(', ');
                    }
                }
                // prepend zeroes for sorting
                var value_sort = new Bitcoin.BigInteger(Math.pow(10, 19).toString()).add(value).toString();
                while (value_sort.length < 20) value_sort = '0' + value_sort;
                retval.push({ts: new Date(tx.created_at.replace(' ', 'T')), txhash: tx.txhash, memo: tx.memo,
                             value_sort: value_sort, value: value, instant: tx.instant,
                             value_fiat: data.fiat_value ? value * data.fiat_value / Math.pow(10, 8) : undefined,
                             redeemable_value: redeemable_value, negative: negative, positive: positive,
                             description: description, external_social: external_social, unclaimed: unclaimed,
                             pubkey_pointer: pubkey_pointer, inputs: inputs, outputs: outputs,
                             fee: in_val.subtract(out_val).toString(),
                             nonzero: value.compareTo(new Bitcoin.BigInteger('0')) != 0,
                             redeemable: redeemable_value.compareTo(new Bitcoin.BigInteger('0')) > 0,
                             redeemable_unspent: redeemable_unspent,
                             sent_back: sent_back, block_height: tx.block_height,
                             confirmations: tx.block_height ? data.cur_block - tx.block_height + 1: 0,
                             has_payment_request: tx.has_payment_request,
                             double_spent_by: tx.double_spent_by, rawtx: tx.data,
                             social_destination: tx_social_destination, social_value: tx_social_value});
                // tx.unclaimed is later used for cache updating
                tx.unclaimed = retval[0].unclaimed || (retval[0].redeemable && retval[0].redeemable_unspent);
            }

            d.resolve({fiat_currency: data.fiat_currency, list: retval, sorting: sorting, date_range: date_range,
                        populate_csv: function() {
                            var csv_list = [gettext('Time,Description,satoshis,')+this.fiat_currency];
                            for (var i = 0; i < this.list.length; i++) {
                                var item = this.list[i];
                                csv_list.push(item.ts + ',' + item.description.replace(',', '\'') + ',' + item.value + ',' + item.value_fiat);
                            }
                            this.csv = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv_list.join('\n'));
                        },
                        next_page_id: data.next_page_id,
                        fetch_next_page: function() {
                            var that = this;
                            walletsService._getTransactions($scope, notifydata, that.next_page_id, query, that.sorting, that.date_range).then(function(result) {
                                that.list = that.list.concat(result.list);
                                that.next_page_id = result.next_page_id;
                            });
                        },
                        sort_by: function(sorting) {
                            var that = this;
                            walletsService._getTransactions($scope, notifydata, null, query, sorting, that.date_range).then(function(result) {
                                that.sorting = sorting;
                                if (sorting.order_by == 'ts' && sorting.reversed) {
                                    $scope.wallet.transactions.pending_from_notification = false;
                                    $scope.wallet.transactions.pending_conf_from_notification = false;
                                }
                                that.list = result.list;
                                that.next_page_id = result.next_page_id;
                            });
                        }});
        }, function(err) {
            notices.makeNotice('error', err.desc);
            d.reject(err);
        }).finally(function() { $rootScope.is_loading -= 1; });
        return d.promise
    };
    var _sign_and_send_tx = function($scope, data, priv_der, twofactor, notify, progress_cb, send_after) {
        var d = $q.defer();
        var tx = Bitcoin.Transaction.deserialize(data.tx);
        var signatures = [], device_deferred = null, signed_n = 0;

        for (var i = 0; i < tx.ins.length; ++i) {
            (function(i) {
                var key, path = [];
                if (data.prev_outputs[i].privkey) {
                    key = $q.when(data.prev_outputs[i].privkey);
                } else if (tx_sender.hdwallet.priv) {
                    if (priv_der) {
                        key = $timeout(function() {
                                return $q.when(tx_sender.hdwallet.derivePrivate(data.prev_outputs[i].branch)).then(function(key) {
                                    return key.derivePrivate(data.prev_outputs[i].pointer);
                                });
                            });
                    } else {
                        key = $timeout(function() {
                            key = $q.when(tx_sender.hdwallet.derive(data.prev_outputs[i].branch));
                            if (data.prev_outputs[i].subaccount) {
                                key = key.then(function(key) {
                                    return key.derivePrivate(data.prev_outputs[i].subaccount);
                                });
                            }
                            key = key.then(function(key) {
                                return key.derive(data.prev_outputs[i].pointer);
                            });
                            return key;
                        });
                    }
                    key = key.then(function(key) {
                        return key.priv;
                    });
                } else {
                    if (priv_der) {
                        path.push(data.prev_outputs[i].branch + "'");
                        path.push(data.prev_outputs[i].pointer + "'");
                    } else {
                        path.push(data.prev_outputs[i].branch);
                        if (data.prev_outputs[i].subaccount) {
                            path.push(data.prev_outputs[i].subaccount + "'");
                        }
                        path.push(data.prev_outputs[i].pointer);
                    }
                }
                if (!key) {
                    var script = new Bitcoin.Script(Bitcoin.convert.hexToBytes(data.prev_outputs[i].script));
                    var SIGHASH_ALL = 1;
                    var sign_deferred = $q.defer();

                    var next = function() {
                        return $scope.wallet.btchip.gaStartUntrustedHashTransactionInput_async(
                            i == 0,
                            tx.cloneTransactionForSignature(script, i, SIGHASH_ALL)
                        ).then(function(finished) {
                            var this_ms = 0, this_expected_ms = 6500;
                            var int_promise = $interval(function() {
                                this_ms += 100;
                                var progress = signed_n / tx.ins.length;
                                progress += (1/tx.ins.length) * (this_ms/this_expected_ms);
                                if (progress_cb) progress_cb(Math.min(100, Math.round(100 * progress)));
                            }, 100);
                            return $scope.wallet.btchip.app.gaUntrustedHashTransactionInputFinalizeFull_async(tx).then(function(finished) {
                                return $scope.wallet.btchip.app.signTransaction_async(path.join('/')).then(function(sig) {
                                    $interval.cancel(int_promise);
                                    signed_n += 1;
                                    sign_deferred.resolve(sig.toString(HEX));
                                }, sign_deferred.reject);
                            }, sign_deferred.reject)
                        }, sign_deferred.reject);
                    }

                    if (!device_deferred) {
                        device_deferred = next();
                    } else {
                        device_deferred = device_deferred.then(next);
                    }

                    var sign = sign_deferred.promise;
                } else {
                    var sign = key.then(function(key) {
                        signed_n += 1;
                        if (progress_cb) progress_cb(Math.round(100 * signed_n / tx.ins.length));
                        var script = new Bitcoin.Script(Bitcoin.convert.hexToBytes(data.prev_outputs[i].script));
                        var SIGHASH_ALL = 1;
                        var sign = key.sign(tx.hashTransactionForSignature(script, i, SIGHASH_ALL));
                        sign.push(SIGHASH_ALL);
                        return Bitcoin.convert.bytesToHex(sign);
                    });
                }
                signatures.push(sign);
            })(i);
        }
        if (!send_after) {
            var send_after = $q.when();
        }
        var d_all = $q.all(signatures);
        send_after.then(function() {
            d_all.then(function(signatures) {
                tx_sender.call("http://greenaddressit.com/vault/send_tx", signatures, twofactor||null).then(function(data) {
                    d.resolve();
                    if (!twofactor && $scope) {
                        tx_sender.call("http://greenaddressit.com/login/get_spending_limits").then(function(data) {
                            $scope.wallet.limits.total = data.total;
                        });
                    }
                    if (notify !== false) {
                        sound.play(BASE_URL + "/static/sound/coinsent.mp3", $scope);
                        notices.makeNotice('success', notify || gettext('Bitcoin transaction sent!'));
                    }
                }, function(reason) {
                    d.reject();
                    notices.makeNotice('error', gettext('Transaction failed: ') + reason.desc);
                    sound.play(BASE_URL + "/static/sound/wentwrong.mp3", $scope);
                });
            }, d.reject);
        }, d.reject);
        return d.promise;
    }
    walletsService.getTwoFacConfig = function($scope, force) {
        var d = $q.defer();
        if ($scope.wallet.twofac !== undefined && !force) {
            d.resolve($scope.wallet.twofac);
        } else {
            tx_sender.call('http://greenaddressit.com/twofactor/get_config').then(function(data) {
                $scope.wallet.twofac = data;
                d.resolve($scope.wallet.twofac);
            });
        }
        return d.promise;
    };
    walletsService.get_two_factor_code = function($scope, action, data, redeposit) {
        var deferred = $q.defer();
        walletsService.getTwoFacConfig($scope).then(function(twofac_data) {
            if (twofac_data.any) {
                $scope.twofactor_method_names = {
                    'gauth': 'Google Authenticator',
                    'email': 'Email',
                    'sms': 'SMS',
                    'phone': gettext('Phone')
                };
                $scope.twofactor_methods = [];
                for (var key in $scope.twofactor_method_names) {
                    if (twofac_data[key] === true) {
                        $scope.twofactor_methods.push(key);
                    }
                };
                var order = ['gauth', 'email', 'sms', 'phone'];
                $scope.twofactor_methods.sort(function(a,b) { return order.indexOf(a)-order.indexOf(b); })
                $scope.twofac = {
                    twofactor_method: $scope.twofactor_methods[0],
                    codes_requested: {},
                    request_code: function() {
                        var that = this;
                        this.requesting_code = true;
                        return tx_sender.call('http://greenaddressit.com/twofactor/request_' + this.twofactor_method,
                                action, data).then(function() {
                            that.codes_requested[that.twofactor_method] = true;
                            that.requesting_code = false;
                        }, function(err) {
                            notices.makeNotice('error', err.desc);
                            that.requesting_code = false;
                        });
                    }};
                var show_modal = function() {
                    var modal = $modal.open({
                        templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_2fa.html',
                        scope: $scope,
                        windowClass: 'twofactor'
                    });
                    modal.opened.then(function() { focus("twoFactorModal"); });
                    deferred.resolve(modal.result.then(function(twofac_data) {
                        if (twofac_data.method == 'gauth' && redeposit) {
                            return tx_sender.call('http://greenaddressit.com/twofactor/request_redeposit_proxy', twofac_data).then(function(data) {
                                return {'method': 'proxy', 'code': data};
                            });
                        } else {
                            return twofac_data;
                        }
                    }));
                };
                if ($scope.twofactor_methods.length == 1) {
                    if ($scope.twofactor_methods[0] == 'gauth') {
                        // just gauth - no request required
                        $scope.twofac.gauth_only = true;  // don't display the radio buttons
                                                          // (not required in 'else' because codes_requested takes care of it)
                        show_modal();
                    } else {
                        // just sth else than gauth - request it because user can't choose anything else anyway
                        $scope.twofac.twofactor_method = $scope.twofactor_methods[0];
                        $scope.twofac.request_code().then(function() {
                            show_modal();
                        })
                    }
                } else {
                    // more than one auth method available - allow the user to select
                    show_modal();
                }
            } else {
                return deferred.resolve(null);
            }
        });
        return deferred.promise;
    }
    walletsService.sign_and_send_tx = function($scope, data, priv_der, twofac_data, notify, progress_cb, send_after) {
        if ($scope && data.requires_2factor) {
            var d = $q.defer();
            walletsService.get_two_factor_code($scope, 'send_tx').then(function(twofac_data) {
                d.resolve(_sign_and_send_tx($scope, data, priv_der, twofac_data, notify, progress_cb, send_after));
            }, function(err) { d.reject(err); });
            return d.promise;
        } else {
            return _sign_and_send_tx($scope, data, priv_der, twofac_data, notify, progress_cb, send_after);
        }
    }
    walletsService.addCurrencyConversion = function($scope, model_name) {
        var div = {'BTC': 1, 'mBTC': 1000, 'µBTC': 1000000}[$scope.wallet.unit];
        var unitPlaces = {'BTC': 8, 'mBTC': 5, 'µBTC': 2}[$scope.wallet.unit];
        var trimDecimalPlaces = function(numPlaces, val) {
            return (Math.round(val * Math.pow(10, numPlaces)) / Math.pow(10, numPlaces));
        }
        $scope.$watch(model_name+'.amount', function(newValue, oldValue) {
            // don't check for newValue == oldValue to allow conversion to happen
            // in 'send' form even when using plain (non-payreq) bitcoin: URI with amount
            var _update = function() {
                if ($scope[model_name].updated_by_conversion) {
                    $scope[model_name].updated_by_conversion = false;
                } else {
                    var oldFiat = $scope[model_name].amount_fiat;
                    if (!newValue) {
                        $scope[model_name].amount_fiat = undefined;
                    } else {
                        $scope[model_name].amount_fiat = newValue * $scope.wallet.fiat_rate / div;
                        $scope[model_name].amount_fiat = trimDecimalPlaces(2, $scope[model_name].amount_fiat);
                    }
                    if ($scope[model_name].amount_fiat !== oldFiat) {
                        $scope[model_name].updated_by_conversion = true;
                    }
                }
            }
            if ($scope.wallet.fiat_rate) {
                _update();
            } else {
                $scope.$on('first_balance_updated', _update);
            }
        });
        $scope.$watch(model_name+'.amount_fiat', function(newValue, oldValue) {
            if (newValue === oldValue) return;
            var _update = function() {
                if ($scope[model_name].updated_by_conversion) {
                    $scope[model_name].updated_by_conversion = false;
                } else {
                    var oldBTC = $scope[model_name].amount;
                    if (!newValue) {
                        $scope[model_name].amount = undefined;
                    } else {
                        $scope[model_name].amount = (div * newValue / $scope.wallet.fiat_rate);
                        $scope[model_name].amount = trimDecimalPlaces(unitPlaces, $scope[model_name].amount);
                    }
                    if ($scope[model_name].amount !== oldBTC) {
                        $scope[model_name].updated_by_conversion = true;
                    }
                }
            }
            if ($scope.wallet.fiat_rate) {
                _update();
            } else {
                $scope.$on('first_balance_updated', _update);
            }
        });
    };
    walletsService.create_pin = function(pin, $scope) {
        var do_create = function() {
            var deferred = $q.defer();
            tx_sender.call('http://greenaddressit.com/pin/set_pin_login', pin, 'Primary').then(
                function(data) {
                    if (data) {
                        var pin_ident = tx_sender.pin_ident = data;
                        storage.set('pin_ident', pin_ident);
                        tx_sender.call('http://greenaddressit.com/pin/get_password', pin, data).then(
                            function(password) {
                                if (!$scope.wallet.hdwallet.seed_hex) {
                                    deferred.reject(gettext('Internal error')+': Missing seed');
                                    return;
                                }
                                if (password) {
                                    var data = JSON.stringify({'seed': $scope.wallet.hdwallet.seed_hex,
                                                               'path_seed': $scope.wallet.gait_path_seed,
                                                               'mnemonic': $scope.wallet.mnemonic});
                                    crypto.encrypt(data, password).then(function(encrypted) {
                                        storage.set('encrypted_seed', encrypted);
                                    });
                                    tx_sender.pin = pin;
                                    deferred.resolve(pin_ident);
                                } else {
                                    deferred.reject(gettext('Failed retrieving password.'))
                                }
                            }, function(err) {
                                deferred.reject(err.desc);
                            });
                    } else {
                        deferred.reject();
                    }
                }, function(err) {
                    deferred.reject(err.desc);
                }
            );
            return deferred.promise;
        };
        if (!tx_sender.logged_in) {
            return $q.when(Bitcoin.HDWallet.fromSeedHex($scope.wallet.hdwallet.seed_hex, cur_net)).then(function(hdwallet) {
                hdwallet.seed_hex = $scope.wallet.hdwallet.seed_hex;
                return walletsService.login($scope||{wallet:{}}, hdwallet,
                        $scope.wallet.mnemonic, false, false, $scope.wallet.gait_path_seed).then(function() {
                    return do_create();
                });
            });
        } else {  // already logged in
            return do_create();
        }
    };
    walletsService.askForLogout = function($scope, text) {
        $scope.ask_for_logout_text = text;
        return $modal.open({
            templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_logout.html',
            scope: $scope
        }).result;
    };
    return walletsService;
}]).factory('notices', ['$rootScope', '$timeout', function($rootScope, $timeout) {
    var notices = $rootScope.notices = [];
    var noticesService = {};
    noticesService.makeNotice = function(type, msg, timeout) {
        if (msg == null || msg.length == 0)
            return;

        console.log(msg);

        var data = {
            type: type,
            msg: msg
        };
        notices.push(data);

        if (timeout == null)
            timeout = 5000;

        if (timeout > 0) {
            $timeout(function() {
                for (var i = 0; i < notices.length; ++i) {
                    if (notices[i] === data) {
                        notices.splice(i, 1);
                    }
                }
            }, timeout);
        }
    };
    noticesService.setLoadingText = function(text, ifNotSet) {
        if (!ifNotSet || !$rootScope.loading_text) {
            $rootScope.loading_text = text;
        }
    };
    return noticesService;
}]).factory('tx_sender', ['$q', '$rootScope', 'cordovaReady', '$http', 'notices', 'gaEvent', '$location', 'autotimeout', 'device_id',
        function($q, $rootScope, cordovaReady, $http, notices, gaEvent, $location, autotimeout, device_id) {
    ab._Deferred = $q.defer;
    var txSenderService = {};
    if (window.Electrum) {
        if (window.cordova) {
            txSenderService.electrum = new Electrum($http, $q);
        } else {
            txSenderService.electrum = new Electrum();
            txSenderService.electrum.connectToServer();
        }
    }
    var session, calls = [], calls_missed = {}, calls_counter = 0;
    txSenderService.call = function() {
        var d = $q.defer();
        if (session) {
            var cur_call = calls_counter++;
            calls_missed[cur_call] = [arguments, d];  // will be called on new session
            try {
                session.call.apply(session, arguments).then(function(data) {
                    if (!calls_missed[cur_call]) return;  // avoid resolving the same call twice
                    delete calls_missed[cur_call];
                    $rootScope.$apply(function() { d.resolve(data); })
                }, function(err) {
                    if (!calls_missed[cur_call]) return;  // avoid resolving the same call twice
                    delete calls_missed[cur_call];
                    $rootScope.$apply(function() { d.reject(err); })
                });
            } catch (e) {
                if (!calls_missed[cur_call]) return;  // avoid resolving the same call twice
                delete calls_missed[cur_call];
                $rootScope.$apply(function() { d.reject(gettext('Problem with Internet connection detected. Please try again.')); })

                session = null;
            }
        } else {
            if (disconnected) {
                disconnected = false;
                connect();
            }
            calls.push([arguments, d]);
        }
        return d.promise;
    };
    var isMobile = /Android|iPhone|iPad|iPod|Opera Mini/i.test(navigator.userAgent);
    if (window.cordova) {
        cordovaReady(function() {
            document.addEventListener("resume", function() {
                if (!txSenderService.wallet || !txSenderService.logged_in) return;
                if (session) {
                    session.close();  // reconnect on resume
                }
                session = null;
                disconnected = true;
                txSenderService.wallet.update_balance();
                txSenderService.wallet.refresh_transactions();
            }, false);
        })();
    } else if (isMobile && typeof document.addEventListener !== undefined) {
        // reconnect on tab shown in mobile browsers
        document.addEventListener("visibilitychange", function() {
            if (!document.hidden && txSenderService.wallet && txSenderService.logged_in) {
                txSenderService.wallet.update_balance();
                txSenderService.wallet.refresh_transactions();
            }
        }, false);
    }
    var attempt_login = false;
    var onAuthed = function(s, login_d) {
        session = s;
        session.subscribe('http://greenaddressit.com/tx_notify', function(topic, event) {
            gaEvent('Wallet', 'TransactionNotification');
            $rootScope.$broadcast('transaction', event);
        });
        session.subscribe('http://greenaddressit.com/block_count', function(topic, event) {
            $rootScope.$broadcast('block', event);
        });
        var d1, d2, logging_in = false;
        if (txSenderService.hdwallet && (txSenderService.logged_in || attempt_login)) {
            d1 = txSenderService.login('if_same_device', true); // logout=if_same_device, force_relogin
            logging_in = true;
        } else if (txSenderService.watch_only) {
            d1 = txSenderService.loginWatchOnly(txSenderService.watch_only[0], txSenderService.watch_only[1]);
            logging_in = true;
        } else {
            d1 = $q.when(true);
        }
        d1.catch(function(err) {
            if (err.uri == 'http://greenaddressit.com/error#doublelogin') {
                autotimeout.stop();
                if (txSenderService.wallet) txSenderService.wallet.clear();
                $location.path('/concurrent_login');
            } else {
                notices.makeNotice('error', gettext('An error has occured which forced us to log you out.'))
                if (txSenderService.wallet) txSenderService.wallet.clear();
                $location.path('/');
            }
        });
        if (txSenderService.pin_ident) {
            // resend PIN to allow PIN changes in the event of reconnect
            d2 = session.call('http://greenaddressit.com/pin/get_password',
                              txSenderService.pin, txSenderService.pin_ident);
        } else {
            d2 = $q.when(true);
        }
        $q.all([d1, d2]).then(function(results) {
            if (logging_in && login_d) {
                login_d.resolve(results[0]);
            }
            // missed calls queues
            for (i in calls_missed) {
                var item = calls_missed[i];
                delete calls_missed[i];
                item[1].resolve(txSenderService.call.apply(session, item[0]));
            }
            while (calls.length) {
                var item = calls.shift();
                item[1].resolve(txSenderService.call.apply(session, item[0]));
            }
        }, function(err) {
            // missed calls queue - reject them as well
            // safeApply because txSenderService.login might've called $apply already
            $rootScope.safeApply(function() {
                while (calls.length) {
                    var item = calls.shift();
                    item[1].reject(err);
                }
            });
        });
    };
    var retries = 60, everConnected = false, disconnected = false, connecting = false;
    var connect = function(login_d) {
        if (connecting) return;
        connecting = true;
        ab.connect(wss_url,
            function(s) {
                everConnected = true;
                $http.get((window.root_url||'')+'/token/').then(function(response) {
                    var token = response.data;
                    s.authreq(token).then(function(challenge) {
                        var signature = s.authsign(challenge, token);
                        s.auth(signature).then(function(permissions) {
                            connecting = false;
                            onAuthed(s, login_d);
                        });
                    });
                });
            },
            function(code, reason) {
                if (retries && !everConnected) {  // autobahnjs doesn't reconnect automatically if it never managed to connect
                    retries -= 1;
                    setTimeout(connect, 5000);
                    return;
                }
                if (reason && reason.indexOf('WS-4000') != -1) {
                    $rootScope.$apply(function() {
                        autotimeout.stop();
                        txSenderService.logout();
                        $location.path('/concurrent_login');
                    });
                }
                if (reason && reason.indexOf('WS-4001') != -1) {  // concurrent login on the same device
                    $rootScope.$apply(function() {
                        autotimeout.stop();
                        txSenderService.logout();
                        $location.path('/');
                    });
                }
                session = null;
                disconnected = true;
                connecting = false;
            },
            {maxRetries: 60}
        );
    };
    cordovaReady(connect)();
    txSenderService.logged_in = false;
    txSenderService.login = function(logout, force_relogin) {
        var d = $q.defer();
        if (txSenderService.logged_in && !force_relogin) {
            d.resolve(txSenderService.logged_in);
        } else {
            var hdwallet = txSenderService.hdwallet;
            if (hdwallet.priv) {
                attempt_login = true;
                if (session) {
                    session.call('http://greenaddressit.com/login/get_challenge',
                            hdwallet.getAddress().toString()).then(function(challenge) {
                        var challenge_bytes = new Bitcoin.BigInteger(challenge).toByteArrayUnsigned();

                        // generate random path to derive key from - avoids signing using the same key twice
                        var max64int_hex = '';
                        while (max64int_hex.length < 16) max64int_hex += 'F';
                        var TWOPOWER64 = new Bitcoin.BigInteger(max64int_hex, 16).add(Bitcoin.BigInteger.ONE);
                        var random_path_hex = Bitcoin.ecdsa.getBigRandom(TWOPOWER64).toString(16);
                        while (random_path_hex.length < 16) random_path_hex = '0' + random_path_hex;
                        $q.when(hdwallet.subpath_for_login(random_path_hex)).then(function(subhd) {
                            $q.when(subhd.priv.sign(challenge_bytes)).then(function(signature) {
                                signature = Bitcoin.ecdsa.parseSig(signature);
                                d.resolve(device_id().then(function(devid) {
                                    if (session) {
                                        return session.call('http://greenaddressit.com/login/authenticate',
                                                [signature.r.toString(), signature.s.toString()], logout||false,
                                                 random_path_hex, devid).then(function(data) {
                                            txSenderService.logged_in = data;
                                            return data;
                                        });
                                    } else if (disconnected) {
                                        d = $q.defer();
                                        connect(d);
                                        return d.promise;
                                    }
                                }));
                            });
                        });
                    });
                } else if (disconnected) {
                    d = $q.defer();
                    connect(d);
                    return d.promise;
                }
            } else {  // trezor_dev || btchip

                var trezor_dev = txSenderService.trezor_dev,
                    btchip = txSenderService.btchip;
                var get_pubkey = function() {
                    if (trezor_dev) {
                        return $q.when(txSenderService.trezor_address);
                    } else {
                        return $q.when(txSenderService.btchip_address);
                    }
                }
                get_pubkey().then(function (addr) {
                    txSenderService.call('http://greenaddressit.com/login/get_trezor_challenge',
                            addr).then(function(challenge) {
                        var msg_plain = 'greenaddress.it      login ' + challenge;
                        var msg = Bitcoin.CryptoJS.enc.Hex.stringify(Bitcoin.CryptoJS.enc.Utf8.parse(msg_plain));
                        // btchip requires 0xB11E to skip HID authentication
                        // 0x4741 = 18241 = 256*G + A in ASCII
                        var path = [0x4741b11e];

                        if (trezor_dev) {
                            trezor_dev.signing = true;
                            trezor_dev._typedCommonCall('SignMessage', 'MessageSignature',
                                    {'message': msg, address_n: path}).then(function(res) {
                                var signature = Bitcoin.ecdsa.parseSigCompact(Bitcoin.convert.hexToBytes(res.message.signature));
                                trezor_dev.signing = false;
                                d.resolve(device_id().then(function(devid) {
                                    return txSenderService.call('http://greenaddressit.com/login/authenticate',
                                            [signature.r.toString(), signature.s.toString(), signature.i.toString()], logout||false,
                                             'GA', devid).then(function(data) {
                                        txSenderService.logged_in = data;
                                        return data;
                                    });
                                }));
                            }, function(err) {
                                d.reject(err.message);
                                trezor_dev.signing = false;
                            });
                        } else {
                            var t0 = new Date();
                            $q.when(hdwallet.derive(path[0])).then(function(result_pk) {
                                btchip.app.signMessagePrepare_async(path.join('/'), new ByteString(msg, HEX)).then(function(result) {
                                    btchip.app.signMessageSign_async(new ByteString("00", HEX)).then(function(result) {
                                        var signature = Bitcoin.ecdsa.parseSig(Bitcoin.convert.hexToBytes(result.toString(HEX)));
                                        var i = Bitcoin.ecdsa.calcPubKeyRecoveryParam(
                                            result_pk.pub.pub, signature.r, signature.s, Bitcoin.Message.magicHash(msg_plain));
                                        d.resolve(device_id().then(function(devid) {
                                            return txSenderService.call('http://greenaddressit.com/login/authenticate',
                                                    [signature.r.toString(), signature.s.toString(), i.toString()], logout||false,
                                                     'GA', devid).then(function(data) {
                                                txSenderService.logged_in = data;
                                                return data;
                                            });
                                        }));
                                    });
                                });
                            });
                        }
                    });
                });
            }
        }
        return d.promise;
    };
    txSenderService.logout = function() {
        if (session) {
            session.close();
        }
        if (txSenderService.btchip) {
            txSenderService.btchip.dongle.disconnect_async();
        }
        disconnected = true;
        txSenderService.logged_in = false;
        attempt_login = false;
        txSenderService.hdwallet = undefined;
        txSenderService.trezor_dev = undefined;
        txSenderService.watch_only = undefined;
        if (txSenderService.wallet) txSenderService.wallet.clear();
    };
    txSenderService.loginWatchOnly = function(token_type, token, logout) {
        var d = $q.defer();
        txSenderService.call('http://greenaddressit.com/login/watch_only',
            token_type, token, logout||false).then(function(data) {
                txSenderService.watch_only = [token_type, token];
                d.resolve(data);
            }, function(err) {
                d.reject(err);
            });
        return d.promise;
    };
    txSenderService.change_pin = function(new_pin) {
        return txSenderService.call('http://greenaddressit.com/pin/change_pin_login',
                new_pin, txSenderService.pin_ident).then(function() {
            // keep new pin for reconnection handling
            txSenderService.pin = new_pin;
        });
    };
    return txSenderService;
}]).factory('facebook', ['$q', '$rootScope', 'cordovaReady', '$interval', function($q, $rootScope, cordovaReady, $interval) {
    if (!document.getElementById('fb-root')) return;

    var FB_deferred = $q.defer();
    var FB_promise = FB_deferred.promise;
    var initd = false;
    window.fbAsyncInit = function() {
        $interval.cancel(FB_interval_promise);
        cordovaReady(function() {
            FB_deferred.resolve();
        })();
    };
    if (window.cordova) {
        // fbAsyncInit is not called for some reason in Cordova, so we poll for FB
        var FB_interval_promise = $interval(function() {
            if (window.FB) {
                window.fbAsyncInit();
            }
        }, 100, 50);  // try for 5 seconds
    }

    cordovaReady(function() {
        var e = document.createElement('script');e.async = true;
        e.src = 'https://connect.facebook.net/en_US/all.js';
        document.getElementById('fb-root').appendChild(e);
    })();

    var logged_in = false;
    var login_deferred = $q.defer();
    FB_promise = FB_promise.then(function() {
        FB.Event.subscribe('auth.authResponseChange', function(response) {
            if (response.status == 'connected') {
                logged_in = true;
                $rootScope.safeApply(function() {
                    login_deferred.resolve();
                });
            }
        });

        if (window.cordova) {
            FB.init({
                appId: FB_APP_ID,
                nativeInterface: CDV.FB,
                useCachedDialogs: false
            });
        } else {
            FB.init({
                appId: FB_APP_ID,
                status: true
            });
        }

        initd = true;
    });


    var facebookService = {};
    facebookService.login = function(loginstate) {
        if (loginstate.logging_in && !initd) return;
        if (logged_in) {
            loginstate.logged_in = true;
            return $q.when(true);
        }
        loginstate.logging_in = true;
        var deferred = $q.defer();
        FB.login(function(response) {
            $rootScope.$apply(function() {
                if (response.authResponse) {
                    loginstate.logged_in = true;
                    deferred.resolve();
                } else {
                    deferred.reject();
                }
                loginstate.logging_in = false;
            });
        }, {scope: ''});
        return deferred.promise;
    };

    facebookService.getUser = function() {
        login_deferred = login_deferred.then(function() {
            var inner_deferred = $q.defer();
            FB.api('/me', function(response) {
                $rootScope.$apply(function() {
                    inner_deferred.resolve(response);
                });
            });
            return inner_deferred.promise;
        });
        return login_deferred;
    };

    return facebookService;
}]).factory('reddit', ['$q', function($q) {
    var redditService = {
        getToken: function(scope) {
            var tokenDeferred = $q.defer();
            var state = Math.random();
            var left = screen.width / 2 - 500, top = screen.height / 2 - 300;
            if (window.location.hostname == 'localhost') {
                var redir = 'http://localhost:9908/reddit/';
            } else {
                var redir = 'https://'+window.location.hostname+'/reddit/';
            }
            var w = window.open('https://ssl.reddit.com/api/v1/authorize?client_id='+REDDIT_APP_ID+'&redirect_uri='+redir+'&response_type=code&scope='+scope+'&state=' + state,
                        '_blank', 'toolbar=0,menubar=0,width=1000,height=600,left='+left+',top='+top);
            var deferred = $q.defer();
            var interval = setInterval(function() { if (w.closed) {
                clearInterval(interval);
                deferred.resolve(true);
            } }, 500);
            deferred.promise.then(function() {
                if (window._reddit_token) {
                    tokenDeferred.resolve(_reddit_token);
                    _reddit_token = undefined;
                } else {
                    tokenDeferred.resolve(null);
                }
            });
            return tokenDeferred.promise;
        }
    };
    return redditService;
}]).factory('cordovaReady', function cordovaReady() {
  return function (fn) {
    // cordovaReady is called even when there is no Cordova support, hence
    // the plain `return fn` below.

    // This is because WebSockets are implemented on Android in Cordova,
    // so the initial implementation was a generic wrapper which runs
    // code even without Cordova, to allow running the same WebSockets
    // code on desktop and Android.

    // (See the usage in js/greenwallet/services.js: ab.connect()
    // is wrapped inside cordovaReady, because it uses WebSockets)

    // Maybe it might be better to add some runEvenWithoutCordova
    // argument to cordovaReady for that WebSockets special case,
    // and by default don't run anything on desktop from the function
    // returned there...
    if (!window.cordova) {
        return fn;
    }

    var queue = [];

    var impl = function () {
      queue.push([this, Array.prototype.slice.call(arguments)]);
    };

    document.addEventListener('deviceready', function () {
      queue.forEach(function (args) {
        fn.apply(args[0], args[1]);
      });
      impl = fn;
      navigator.splashscreen.hide();
    }, false);

    return function () {
      return impl.apply(this, arguments);
    };
  };
}).factory('hostname', function() {
    var is_chrome_app = window.chrome && chrome.storage;
    if (is_chrome_app || window.cordova) {
        return 'greenaddress.it';
    } else {
        return window.location.hostname.replace('cordova.', '').replace('cordova-t.', '')
    }
}).factory('gaEvent', function gaEvent() {
    return function(category, action, label) {
        if (window._gaq) {
            try {
                if (category == '_pageview') {
                    _gaq.push(['_trackPageview', action]);
                } else {
                    _gaq.push(['_trackEvent', category, action, label]);
                }
            } catch (e) {}
        }
    }
}).factory('parseKeyValue', function() {
    var tryDecodeURIComponent = function (value) {
        try {
            return decodeURIComponent(value);
        } catch(e) {
            // Ignore any invalid uri component
        }
    };
    return function parseKeyValue(keyValue) {
        var obj = {}, key_value, key;
        angular.forEach((keyValue || "").split('&'), function(keyValue){
            if ( keyValue ) {
            key_value = keyValue.split('=');
            key = tryDecodeURIComponent(key_value[0]);
            if ( key !== undefined ) {
                var val = (key_value[1] !== undefined) ? tryDecodeURIComponent(key_value[1]) : true;
                if (!obj[key]) {
                    obj[key] = val;
                } else if(toString.call(obj[key]) === '[object Array]') {
                    obj[key].push(val);
                } else {
                    obj[key] = [obj[key],val];
                }
            }
        }
      });
      return obj;
    };
}).factory('parse_bitcoin_uri', ['parseKeyValue', function(parseKeyValue) {
    return function parse_bitcoin_uri(uri) {
        if (uri.indexOf === undefined || uri.indexOf("bitcoin:") == -1) {
            // not a URI
            return {};
        } else {
            if (uri.indexOf("?") == -1) {
                // no amount
                return {recipient: uri.split("bitcoin:")[1]};
            } else {
                var recipient =  uri.split("bitcoin:")[1].split("?")[0];
                var variables = parseKeyValue(uri.split('bitcoin:')[1].split('?')[1]);
                variables.recipient = recipient;
                return variables;
            }
        }
    }
}]).factory('storage', ['$q', function($q) {
    if (window.chrome && chrome.storage) {
        var noLocalStorage = false;
    } else {
        try {
            var noLocalStorage = !window.localStorage;
        } catch(e) {
            var noLocalStorage = true;
        }
    }
    var storageService = {
        noLocalStorage: noLocalStorage,
        set: function(key, value) {
            if (window.chrome && chrome.storage) {
                var set_value = {};
                set_value[key] = value;
                chrome.storage.local.set(set_value);
            } else {
                if(!noLocalStorage) {
                    localStorage.setItem(key, value);
                }
            }
        },
        get: function(key) {
            var d = $q.defer();
            if (window.chrome && chrome.storage) {
                chrome.storage.local.get(key, function(items) {
                    if (key.constructor === Array) {
                        d.resolve(items);
                    } else {
                        d.resolve(items[key]);
                    }
                });
            } else {
                if (key.constructor === Array) {
                    var ret = {};
                    if (!noLocalStorage) {
                        for (var i = 0; i < key.length; ++i) {
                            ret[key[i]] = localStorage.getItem(key[i]);
                        }
                    }
                    d.resolve(ret);
                } else {
                    if (!noLocalStorage) {
                        d.resolve(localStorage.getItem(key));
                    } else {
                        d.resolve();
                    }
                }
            }
            return d.promise;
        },
        remove: function(key) {
            if (window.chrome && chrome.storage) {
                chrome.storage.local.remove(key);
            } else {
                localStorage.removeItem(key);
            }
        }
    };
    return storageService;
}]).factory('device_id', ['storage', function(storage) {
    var uuid4 = function() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var nums = new Uint32Array(1), r, v;
            window.crypto.getRandomValues(nums);
            r = nums[0] % 16,
            v = (c === 'x') ? r : (r&0x3|0x8);
            return v.toString(16);
        });
    }
    return function() {
        return storage.get('device_id').then(function(value) {
            if (!value) {
                var ret = uuid4();
                storage.set('device_id', ret)
                return ret;
            } else return value;
        })
    };
}]).factory('addressbook', ['$rootScope', 'tx_sender', 'storage', 'crypto', 'notices', '$q',
        function($rootScope, tx_sender, storage, crypto, notices, $q) {
    return {
        items: [],
        reverse: {},
        new_item: undefined,
        populate_csv: function() {
            var csv_list = [];
            for (var i = 0; i < this.items.length; i++) {
                var item = this.items[i];
                csv_list.push(item.name + ',' + (item.href || item.address));
            }
            this.csv = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv_list.join('\n'));
        },
        init_partitions: function(items) {
            var items = items || this.items, next_prefix, next_partition;
            var items_copy = [];
            for (var i = 0; i < items.length; i++) items_copy.push(items[i]);
            var PER_PAGE = 15;
            this.partitions = [];
            var get_name = function (item) {
                // works with 'unprocessed' and 'processed' items
                if (item.name) return item.name;
                else return item[0];
            }
            while (items_copy.length) {
                var prefix = next_prefix || get_name(items_copy[0])[0];
                var partition = next_partition || [];
                for (var i = 0; i < PER_PAGE; i++) {
                    if (!items_copy.length) break;
                    var next_item = this._process_item(items_copy.shift());
                    if (next_item) partition.push(next_item);
                    else i -= 1;  // crx facebook
                }
                if (items_copy.length) {
                    var next_prefix = get_name(items_copy[0])[0], next_partition = [];
                    while (next_prefix == partition[partition.length-1].name.substring(0, next_prefix.length) &&
                           next_prefix.length < get_name(items_copy[0]).length) {
                        next_prefix += get_name(items_copy[0])[next_prefix.length];
                        if (next_prefix.length == 3) {
                            while (partition.length &&
                                    partition[partition.length-1].name.substring(0, 3) == next_prefix) {
                                next_partition.push(partition.pop());
                            }
                            break;
                        }
                    }
                }
                if (partition.length) {
                    this.partitions.push([this.partitions.length+1, prefix, partition]);
                }
            }
        },
        _process_item: function(value) {
            var is_chrome_app = window.chrome && chrome.storage;
            if (value[3] == 'facebook') {
                var has_wallet = value[4];
                if (!has_wallet && (is_chrome_app || window.cordova)) return;  // can't send FB messages from Chrome/Cordova app
                var href = 'https://www.facebook.com/' + value[1];
                return {name: value[0], type: value[3], address: value[1], has_wallet: has_wallet, href: href};
            } else {
                return {name: value[0], type: value[3], has_wallet: value[4], address: value[1]};
            }
        },
        update_with_items: function(items, $routeParams) {
            while (this.items.length) this.items.pop();
            this.reverse = {};
            if (!$routeParams) $routeParams = {};
            var that = this;
            items.sort(function(a, b) { return a[0].localeCompare(b[0]); });
            this.init_partitions(items);
            var i = 0;
            angular.forEach(items, function(value) {
                var item = that._process_item(value);
                if (!item) return;  // crx facebook
                if (value[3] != 'facebook') {
                    that.reverse[value[1]] = value[0];
                }
                that.items.push(item);
                if (value[0] === $routeParams.name) $routeParams.page = Math.ceil((i+1)/20);
                i += 1;
            });
            that.num_pages = Math.ceil(that.items.length / 20);
            that.pages = [];
            for (var i = 1; i <= that.num_pages; i++) that.pages.push(i);
            that.populate_csv();
        },
        load: function($scope, $routeParams) {
            var addressbook_key = $scope.wallet.receiving_id + 'addressbook'
            var cache;
            var that = this;
            return storage.get(addressbook_key).then(function(cache) {
                try {
                    cache = JSON.parse(cache) || {};
                } catch(e) {
                    cache = {};
                }
                var d;
                if (cache.hashed) {
                    d = crypto.decrypt(cache.items, $scope.wallet.cache_password).then(function(decrypted) {
                        that.update_with_items(JSON.parse(decrypted), $routeParams);
                    });
                    var requires_load = false;
                } else {
                    $rootScope.is_loading += 1;
                    d = $q.when();
                    requires_load = true;
                }

                return d.then(function() {
                    return tx_sender.call('http://greenaddressit.com/addressbook/read_all', cache.hashed).then(function(data) {
                        if (data.items) {
                            var items = data.items;
                            crypto.encrypt(JSON.stringify(data.items), $scope.wallet.cache_password).then(function(encrypted) {
                                cache.items = encrypted;
                                cache.hashed = data.hashed;
                                storage.set(addressbook_key, JSON.stringify(cache));
                            });
                            that.update_with_items(items, $routeParams);
                        }
                    }, function(err) {
                        notices.makeNotice('error', gettext('Error reading address book: ') + err.desc);
                    }).finally(function() {
                        if (requires_load) {
                            $rootScope.is_loading -= 1;
                        }
                    });
                });
            });
        }
    };
}]).factory('clipboard', ['$q', 'cordovaReady', function($q, cordovaReady) {
    return {
        copy: function(data) {
            var deferred = $q.defer();
            cordovaReady(function(){
                cordova.plugins.clipboard.copy(data, function() {
                    deferred.resolve(gettext('Copied'));
                }, function() {
                    deferred.reject(gettext('Error copying'));
                });
            })();
            return deferred.promise;
    }};

}]).factory('sound', ['cordovaReady', '$timeout', function(cordovaReady, $timeout) {
    return {
        play: function(src, $scope) {
            cordovaReady(function(){
                if (!$scope || !$scope.wallet.appearance.sound) {
                    return;
                }
                if (window.cordova && typeof Media != "undefined") {
                    // Phonegap media
                    var mediaRes = new Media(src,
                        function onSuccess() {
                            // release the media resource once finished playing
                            mediaRes.release();
                        },
                        function onError(e){
                            console.log("error playing sound: " + JSON.stringify(e));
                        });
                    mediaRes.play();
                } else if (typeof Audio != "undefined") {
                    //HTML5 Audio
                    $timeout(function() { new Audio(src).play(); });
                } else {
                    console.log("no sound API to play: " + src);
                }
            })();
    }};

}]).factory('qrcode', ['$q', 'cordovaReady', '$timeout', function($q, cordovaReady, $timeout) {
    var n = navigator, v, webkit = false, moz = false, gCtx, stream, gotGUMerror = false;
    return {
    stop_scanning: function($scope) {
        v.pause();
        stream.stop()
        $scope.scanning_qr_video = false;
    },
    scan: function($scope, $event, suffix) {
        var that = this;
        var deferred = $q.defer();
        if (window.cordova) {
            $event.preventDefault();
            cordovaReady(function()  {
                cordova.plugins.barcodeScanner.scan(
                    function (result) {
                        console.log("We got a barcode\n" +
                        "Result: " + result.text + "\n" +
                        "Format: " + result.format + "\n" +
                        "Cancelled: " + result.cancelled);
                        if (!result.cancelled && result.format == "QR_CODE") {
                              $timeout(function() { deferred.resolve(result.text); });
                        } else {
                            if (result.cancelled) {
                                $timeout(function() { deferred.reject(gettext('Cancelled')); });
                            } else {
                                $timeout(function() { deferred.reject(gettext('Invalid format')); });
                            }
                        }
                    },
                    deferred.reject
                );
            })();
        } else {
            v = document.getElementById("v" + (suffix||''));
            qrcode.callback = function(result) {
                if(result === 'error decoding QR Code') {
                    deferred.reject(gettext('Could not process the QR code, the image may be blurry. Please try again.'));
                    return;
                }
                deferred.resolve(result);
            };
            function captureToCanvas() {
                try{
                    gCtx.drawImage(v,0,0);
                    try{
                        qrcode.decode();
                        that.stop_scanning($scope);
                    }
                    catch(e){
                        console.log(e);
                        setTimeout(captureToCanvas, 500);
                    };
                }
                catch(e){
                        console.log(e);
                        setTimeout(captureToCanvas, 500);
                };
            }
            var success = function(stream_) {
                $scope.$apply(function() {
                    $scope.scanning_qr_video = true;
                });
                stream = stream_;
                gCanvas = document.getElementById("qr-canvas");
                var w = 800, h = 600;
                gCanvas.style.width = w + "px";
                gCanvas.style.height = h + "px";
                gCanvas.width = w;
                gCanvas.height = h;
                gCtx = gCanvas.getContext("2d");
                gCtx.clearRect(0, 0, w, h);
                if(webkit)
                    v.src = window.webkitURL.createObjectURL(stream);
                else if(moz){
                    v.mozSrcObject = stream;
                    v.play();
                } else {
                    v.src = stream;
                }
                setTimeout(captureToCanvas, 500);
            }
            var error = function() {
                $scope.gotGUMerror = true; // for some reason dispatchEvent doesn't work inside error()
                deferred.reject(gettext('Access denied. Retry to scan from file.'));
            };
            var scan_input = function() {
                var qr = $event.target;
                angular.element(qr).on('change', function(event) {
                    if (event.target.files.length != 1 && event.target.files[0].type.indexOf("image/") != 0) {
                        notices.makeNotice('error', gettext('You must provide only one image file.'));
                        return;
                    }

                    // https://github.com/kyledrake/coinpunk/blob/master/public/js/coinpunk/controllers/tx.js#L195
                    /*! Copyright (c) 2013, Kyle Drake */
                    var canvas = document.createElement('canvas');
                    var context = canvas.getContext('2d');
                    var img = new Image();
                    img.onload = function() {
                        /*
                        Helpful URLs:
                        http://hacks.mozilla.org/2011/01/how-to-develop-a-html5-image-uploader/
                        http://stackoverflow.com/questions/19432269/ios-html5-canvas-drawimage-vertical-scaling-bug-even-for-small-images

                        There are a lot of arbitrary things here. Help to clean this up welcome.

                        context.save();
                        context.scale(1e6, 1e6);
                        context.drawImage(img, 0, 0, 1e-7, 1e-7, 0, 0, 1e-7, 1e-7);
                        context.restore();
                        */

                        if((img.width == 2448 && img.height == 3264) || (img.width == 3264 && img.height == 2448)) {
                            canvas.width = 1024;
                            canvas.height = 1365;
                            context.drawImage(img, 0, 0, 1024, 1365);
                        } else if(img.width > 1024 || img.height > 1024) {
                            canvas.width = img.width*0.15;
                            canvas.height = img.height*0.15;
                            context.drawImage(img, 0, 0, img.width*0.15, img.height*0.15);
                        } else {
                            canvas.width = img.width;
                            canvas.height = img.height;
                            context.drawImage(img, 0, 0, img.width, img.height);
                        }
                        qrcode.decode(canvas.toDataURL('image/png'));
                    }

                    img.src = URL.createObjectURL(event.target.files[0]);
                });
            };
            var tryGUM = function(source) {
                if (n.getUserMedia && !$scope.gotGUMerror) {
                    n.getUserMedia({video: source, audio: false}, success, error);
                    $event.preventDefault();
                } else if (n.webkitGetUserMedia && !$scope.gotGUMerror) {
                    webkit = true;
                    n.webkitGetUserMedia({video: source, audio: false}, success, error);
                    $event.preventDefault();
                } else if (n.mozGetUserMedia && !$scope.gotGUMerror) {
                    moz = true;
                    n.mozGetUserMedia({video: source, audio: false}, success, error);
                    $event.preventDefault();
                } else {
                    scan_input();
                }
            };
            if (window.MediaStreamTrack && MediaStreamTrack.getSources && !$scope.gotGUMerror) {
                $event.preventDefault();
                MediaStreamTrack.getSources(function(sources) {
                    var found = false;
                    for (var i = 0; i < sources.length; i++) {
                        if (sources[i].kind == 'video' && sources[i].facing == 'environment') {
                            found = true;
                            tryGUM({optional: [{sourceId: sources[i].id}]});
                            break;
                        }
                    }
                    if (!found) tryGUM(true);
                });
            } else {
                tryGUM(true);
            }
        }
        return deferred.promise;
    }};
}]).factory('trezor', ['$q', '$interval', '$modal', 'notices', '$rootScope', 'focus',
        function($q, $interval, $modal, notices, $rootScope, focus) {
    var promptPin = function(type, callback) {
        var scope, modal;

        scope = angular.extend($rootScope.$new(), {
            pin: '',
            type: type
        });

        modal = $modal.open({
            templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_trezor_pin.html',
            size: 'sm',
            windowClass: 'pinmodal',
            backdrop: 'static',
            keyboard: false,
            scope: scope
        });

        modal.result.then(
            function (res) { callback(null, res); },
            function (err) { callback(err); }
        );
    };

    return {
        getDevice: function(noModal) {
            var deferred = $q.defer();

            var tick;
            if (!noModal) {
                var modal = $modal.open({
                    templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_usb_device.html',
                });
                modal.result.finally(function() {
                    if (tick) {
                        $interval.cancel(tick);
                    }
                });
            };

            trezor.load({configUrl: '/static/trezor_config_signed.bin'}).then(function(api) {
                trezor_api = api;
                tick = $interval(function() {
                    if (trezor_api.devices().length) {
                        if (noModal) {
                            $interval.cancel(tick);
                        } else {
                            modal.close();  // modal close cancels the tick
                        }
                        trezor_dev = trezor_api.open(trezor_api.devices()[0]);
                        trezor_dev.on('pin', promptPin);
                        deferred.resolve(trezor_dev);
                    }
                }, 1000);
            }).catch(function(e) {
                $rootScope.safeApply(function() {
                    notices.makeNotice('error', gettext('TREZOR initialisation failed') + ': ' + e);
                });
            });
            return deferred.promise;
        },
        recovery: function(mnemonic) {
            this.getDevice().then(function(dev) {
                dev.wipeDevice().then(function(res) {
                    trezor_dev.on('word', function(cb) {
                        var scope = angular.extend($rootScope.$new(), {
                            word_nums: []
                        });
                        for (var i = 1; i <= 24; i++) scope.word_nums.push(i);
                        var modal = $modal.open({
                            templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_trezor_word.html',
                            scope: scope
                        });
                        modal.result.then(function(word) {
                            if (word.constructor == Number) {
                                cb(null, mnemonic.split(' ')[word]);
                            } else {
                                cb(null, word);
                            }
                        });
                        focus('trezorWordModal');
                    });
                    dev.recoverDevice({
                        'word_count': 24,
                        'pin_protection': false,
                        'passphrase_protection': false
                    }).then(function(res) {
                    });
                });
            });
        }
    }
}]).factory('btchip', ['$q', '$interval', '$modal', '$rootScope', 'mnemonics', 'notices', 'focus',
        function($q, $interval, $modal, $rootScope, mnemonics, notices, focus) {
    var cardFactory;
    if (window.ChromeapiPlugupCardTerminalFactory) {
        cardFactory = new ChromeapiPlugupCardTerminalFactory();
    }

    return {
        _setupWrappers: function(btchip) {
            // wrap some functions to allow using them even after disconnecting the dongle
            // (prompting user to reconnect and enter pin)
            var service = this;
            var WRAP_FUNCS = [
                'gaStartUntrustedHashTransactionInput_async'
            ];
            for (var i = 0; i < WRAP_FUNCS.length; i++) {
                var func_name = WRAP_FUNCS[i];
                btchip[func_name] = function() {
                    var deferred = $q.defer();
                    var origArguments = arguments;
                    try {
                        var d = btchip.app[func_name].apply(btchip.app, arguments)
                    } catch (e) {
                        // handle `throw "Connection is not open"` gracefully - getDevice() below
                        var d = $q.reject();
                    }
                    d.then(function(data) {
                        deferred.resolve(data);
                    }, function(error) {
                        if (!error || !error.indexOf) {
                            service.getDevice().then(function(btchip_) {
                                btchip.app = btchip_.app;
                                btchip.dongle = btchip_.dongle;
                                deferred.resolve(btchip[func_name].apply(btchip, origArguments));
                            });
                        } else {
                            if (error.indexOf("6982") >= 0) {
                                // setMsg("Dongle is locked - enter the PIN");
                                return service.promptPin('', function(err, pin) {
                                    if (!pin) {
                                        deferred.reject();
                                        return;
                                    }
                                    btchip.app.verifyPin_async(new ByteString(pin, ASCII)).then(function() {
                                        deferred.resolve(btchip[func_name].apply(btchip, origArguments));
                                    }).fail(function(error) {
                                        btchip.dongle.disconnect_async();
                                        if (error.indexOf("6982") >= 0) {
                                            notices.makeNotice("error", gettext("Invalid PIN"));
                                        } else if (error.indexOf("6985") >= 0) {
                                            notices.makeNotice("error", gettext("Dongle is not set up"));
                                        } else if (error.indexOf("6faa") >= 0) {
                                            notices.makeNotice("error", gettext("Dongle is locked - reconnect the dongle and retry"));
                                        } else {
                                            notices.makeNotice("error", error);
                                        }
                                        deferred.reject();
                                    });
                                });
                            } else if (error.indexOf("6985") >= 0) {
                                notices.makeMessage('error', gettext("Dongle is not set up"));
                                deferred.reject();
                            } else if (error.indexOf("6faa") >= 0) {
                                notices.makeMessage('error', gettext("Dongle is locked - remove the dongle and retry"));
                                deferred.reject();
                            }
                        }
                    });
                    return deferred.promise;
                }
            }
            return btchip;
        },
        promptPin: function(type, callback) {
            var scope, modal;

            scope = angular.extend($rootScope.$new(), {
                pin: '',
                type: type
            });

            modal = $modal.open({
                templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_btchip_pin.html',
                size: 'sm',
                windowClass: 'pinmodal',
                backdrop: 'static',
                keyboard: false,
                scope: scope
            });

            focus('btchipPinModal');

            return modal.result.then(
                function (res) { return callback(null, res); },
                function (err) { callback(err); }
            );
        },
        getDevice: function(noModal) {
            var service = this;
            var deferred = $q.defer();

            if (!cardFactory) return deferred.promise;

            if (!noModal) {
                var modal = $modal.open({
                    templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_usb_device.html',
                });
                modal.result.finally(function() {
                    $interval.cancel(tick);
                });
            };

            var check = function() {
                cardFactory.list_async().then(function(result) {
                    if (result.length) {
                        cardFactory.getCardTerminal(result[0]).getCard_async().then(function(dongle) {
                            var app = new BTChip(dongle);
                            app.getFirmwareVersion_async().then(function(version) {
                                if (version.firmwareVersion.toString(HEX) < '000104080000') {
                                    var notice = gettext("Old BTChip firmware version detected. Please upgrade to at least %s.").replace('%s', '1.4.8');
                                    notices.makeNotice("error", notice);
                                    return;
                                }
                                if (noModal) {
                                    $interval.cancel(tick);
                                } else {
                                    modal.close();  // modal close cancels the tick
                                }
                                deferred.resolve(service._setupWrappers({dongle: dongle, app: app}));
                            });
                        });
                    }
                });
            }
            var tick = $interval(check, 1000);
            check();

            return deferred.promise;
        },
        setupSeed: function(mnemonic) {
            var deferred = $q.defer();
            var service = this;

            this.getDevice().then(function(btchip_) {
                var scope = $rootScope.$new(),
                    wrong_pin, btchip = btchip_;
                scope.btchip = {
                    already_setup: false,
                    gait_setup: false,
                    storing: false,
                    seed_progress: 0,
                    reset: function() {
                        this.resetting = true;
                        this.resets_remaining = 3;
                        wrong_pin = '00000000000000000000000000000000';
                        var attempt = function() {
                            btchip.app.verifyPin_async(new ByteString(wrong_pin, ASCII)).then(function() {
                                wrong_pin = '1234';
                                attempt();
                            }).fail(function(error) {
                                $rootScope.$apply(function() {
                                    console.log('reset pin error ' + error);
                                    if (error.indexOf("6982") >= 0) {
                                        // setMsg("Dongle is locked - enter the PIN");
                                        scope.btchip.resets_remaining -= 1;
                                    } else if (error.indexOf("6985") >= 0) {
                                        // var setupText = "Dongle is not set up";
                                        scope.btchip.resets_remaining = 0;
                                    }
                                    scope.btchip.replug_required = true;
                                    if (scope.btchip.resets_remaining) {
                                        service.getDevice(true).then(function(btchip_) {
                                            btchip = btchip_;
                                            scope.btchip.replug_required = false;
                                            attempt();
                                        })
                                    } else {
                                        service.getDevice(true).then(function(btchip_) {
                                            btchip = btchip_;
                                            scope.btchip.replug_required = false;
                                            scope.btchip.resetting = false;
                                            scope.btchip.already_setup = false;
                                        });
                                    }
                                });
                            });
                        };
                        attempt();
                    },
                    store: function() {
                        this.storing = true;
                        service.promptPin('', function(err, pin) {
                            if (!pin) return;
                            mnemonics.toSeed(mnemonic).then(function(seed) {
                                btchip.app.setupNew_async(
                                    0x01,  // wallet mode

                                    0x02 | // deterministic signatures
                                    0x08,  // skip second factor if consuming only P2SH inputs in a transaction

                                    Bitcoin.network[cur_net].addressVersion,
                                    Bitcoin.network[cur_net].p2shVersion,
                                    new ByteString(pin, ASCII),
                                    undefined,  // wipePin

                                    // undefined,  // keymapEncoding
                                    // true,  // restoreSeed
                                    new ByteString(seed, HEX) // bip32Seed
                                ).then(function() {
                                    $rootScope.$apply(function() {
                                        scope.btchip.storing = false;
                                        scope.btchip.gait_setup = true;
                                        deferred.resolve();
                                    });
                                }).fail(function(error) {
                                    notices.makeNotice('error', error);
                                    console.log('setupNew_async error: ' + error);
                                });
                            }, null, function(progress) {
                                scope.btchip.seed_progress = progress;
                            });
                        });
                    }
                };
                var do_modal = function() {
                    $modal.open({
                        templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/wallet_modal_btchip_setup.html',
                        scope: scope
                    }).result.finally(function() {
                        btchip.dongle.disconnect_async();
                    });
                }
                btchip.app.getWalletPublicKey_async("0'/0/0").then(function(result) {
                    scope.btchip.already_setup = true;
                    do_modal();
                }).fail(function(error) {
                    if (error.indexOf("6982") >= 0) {
                        // setMsg("Dongle is locked - enter the PIN");
                        scope.btchip.already_setup = true;
                    } else if (error.indexOf("6985") >= 0) {
                        // var setupText = "Dongle is not set up";
                    } else if (error.indexOf("6faa") >= 0) {
                        // setMsg("Dongle is locked - remove the dongle and retry");
                        scope.btchip.already_setup = true;
                    }
                    do_modal();
                });
            });

            return deferred.promise;
        }
    }
}]).factory('bip38', ['$q', '$modal', 'mnemonics', 'focus', function($q, $modal, mnemonics, focus) {
    var bip38Service = {}, iframe;
    bip38Service.processMessage = function(message) {
        var is_chrome_app = window.chrome && chrome.storage;
        d = $q.defer();
        if (window.cordova) {
            var method, data, password = message.password;
            if (message.mnemonic_decrypted) {
                method = "encrypt_raw";
                data = message.mnemonic_decrypted;
            } else if (message.mnemonic_encrypted) {
                method = "decrypt_raw";
                data = message.mnemonic_encrypted;
            }
            cordovaReady(function() {
                cordova.exec(function(result) {
                    d.resolve({data: result});
                }, function(fail) {
                    d.reject(fail);
                }, "BIP38", method, [data, password]);
            })();
        } else if (is_chrome_app) {
            var process = function() {
                var listener = function(message) {
                    window.removeEventListener('message', listener);
                    d.resolve(message);
                };
                window.addEventListener('message', listener);
                iframe.contentWindow.postMessage(message, '*');
            };
            if (!iframe) {
                if (document.getElementById("id_iframe_bip38_service")) {
                    iframe = document.getElementById("id_iframe_bip38_service");
                    process();
                } else {
                    iframe = document.createElement("IFRAME");
                    iframe.onload = process;
                    iframe.setAttribute("src", "/bip38_sandbox.html");
                    iframe.setAttribute("class", "ng-hide");
                    iframe.setAttribute("id", "id_iframe_bip38_service");
                    document.body.appendChild(iframe);
                }
            } else {
                process();
            }
        } else {
            var worker = new Worker("/static/js/bip38_worker.min.js");
            worker.onmessage = function(message) {
                d.resolve(message);
            }
            worker.postMessage(message);
        }
        return d.promise;
    }
    bip38Service.encrypt_mnemonic_modal = function($scope, seed) {
        var d = $q.defer();
        $scope.encrypt_password_modal = {
            encrypt: function() {
                this.error = undefined;
                if (!this.password) {
                    this.error = gettext('Please provide a password.');
                    return;
                }
                if (this.password != this.password_repeated) {
                    this.error = gettext('Passwords do not match.');
                    return;
                }
                this.encrypting = true;
                var that = this;
                bip38Service.processMessage({password: that.password, mnemonic_decrypted: seed}).then(function(message) {
                    mnemonics.toMnemonic(message.data).then(function(mnemonic) {
                        that.encrypting = false;
                        d.resolve(mnemonic);
                        modal.close();
                    });
                });
            }
        };
        var modal = $modal.open({
            templateUrl: BASE_URL+'/'+LANG+'/wallet/partials/signuplogin/modal_encryption_password.html',
            scope: $scope
        });
        modal.opened.then(function() { focus('encryptPasswordModal'); })
        return d.promise;
    };
    return bip38Service;
}]).factory('encode_key', ['$q', function($q) {
    return function(key, passphrase) {
        var base58Check = {
          encode: function(buf) {
            var checkedBuf = [].concat(buf);
            var buf_words = Bitcoin.convert.bytesToWordArray(buf);
            var hash = Bitcoin.CryptoJS.SHA256(Bitcoin.CryptoJS.SHA256(buf_words));
            hash = Bitcoin.convert.wordArrayToBytes(hash);
            checkedBuf = checkedBuf.concat(hash.slice(0, 4));
            return Bitcoin.base58.encode(checkedBuf);
          }
        };
        var data = key.priv.toBytes();
        if (!passphrase) {
            if (cur_net == 'testnet') {
                var version = 0xef;
            } else {
                var version = 0x80;
            }
            data.unshift(version);
            return $q.when(base58Check.encode(data));
        } else {
            var is_chrome_app = window.chrome && chrome.storage;
            var d = $q.defer();
            if (window.cordova) {
                cordovaReady(function() {
                    cordova.exec(function(b58) {
                        d.resolve(b58);
                    }, function(fail) {
                        $rootScope.is_loading -= 1;
                        notices.makeNotice('error', fail);
                        d.reject(fail);
                    }, "BIP38", "encrypt", [data, passphrase,
                            'BTC']);  // probably not correct for testnet, but simpler, and compatible with our JS impl
                })();
            } else if (is_chrome_app) {
                var process = function() {
                    var listener = function(message) {
                        window.removeEventListener('message', listener);
                        d.resolve(message.data);
                    };
                    window.addEventListener('message', listener);
                    iframe.contentWindow.postMessage({eckey: key.priv.toWif(), password: passphrase}, '*');
                };
                if (!iframe) {
                    if (document.getElementById("id_iframe_send_bip38")) {
                        iframe = document.getElementById("id_iframe_send_bip38");
                        process();
                    } else {
                        iframe = document.createElement("IFRAME");
                        iframe.onload = process;
                        iframe.setAttribute("src", "/bip38_sandbox.html");
                        iframe.setAttribute("class", "ng-hide");
                        iframe.setAttribute("id", "id_iframe_send_bip38");
                        document.body.appendChild(iframe);
                    }
                } else {
                    process();
                }
            } else {
                var worker = new Worker("/static/js/bip38_worker.min.js");
                worker.onmessage = function(message) {
                    d.resolve(message.data);
                }
                worker.postMessage({eckey: key.priv.toWif(), password: passphrase});
            }
            return d.promise;
        }
    };
}]);
