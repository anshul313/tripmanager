import Express from 'express';
import http from 'http';
import morgan from 'morgan';
import fetch from 'node-fetch';
import FCM from 'fcm-push';
import bodyParser from 'body-parser';
import _io from 'socket.io';
import config from './config';
import mail from './mail.js';
import nodemailer from 'nodemailer'

const fcm = new FCM(process.env.FCM_KEY);
const app = new Express();
const server = new http.Server(app);
const io = _io(server);
const androidversion = process.env.ANDROID_VERSION;
const transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
        user: 'levotheapp@gmail.com', // Your email id
        pass: 'levitate' // Your password
    }
});

let authUserId = '0';

// Express Logging Middleware
if (global.__DEVELOPMENT__)
    app.use(morgan('combined'));
else
    app.use(morgan('[:date[clf]]: :method :url :status :res[content-length] - :response-time ms'));

// Parse JSON bodies
app.use(bodyParser.json());
app.use('/static', Express.static('static'));

const headers = { 'Content-Type': 'application/json' };
let url = 'http://data.hasura';
if (global.__DEVELOPMENT__) {
    headers.Authorization = 'Bearer ' + process.env.API_TOKEN;
    // url = 'http://data.earthly58.hasura-app.io';
    url = 'https://data.stellar60.hasura-app.io/';
} else {
    headers['X-Hasura-Role'] = 'admin';
    headers['X-Hasura-User-Id'] = 1;
}

const request = (url, options, res, cb) => {
    fetch(url, options)
        .then(
            (response) => {
                if (response.ok) {
                    response
                        .text()
                        .then(d => {
                            (cb(JSON.parse(d)));
                        })
                        .catch(e => {
                            console.error(url, response.status, response.statusText);
                            console.error(e, e.stack);
                            res.status(500).send('Internal error');
                        });
                    return;
                }
                console.error(url, response.status, response.statusText);
                response.text().then(t => (console.log(t)));
                if (res) {
                    res.status(500).send('Internal error');
                }
            },
            (e) => {
                console.error(url, e);
                if (res) {
                    res.status(500).send('Internal error');
                }
            })
        .catch(e => {
            console.error(url, e);
            console.error(e.stack);
            if (res) {
                res.status(500).send('Internal error');
            }
        });
};
const validate = (req) => {
    // Check if req.headers['X-Hasura-Role'] == 'user'
    const authHeader = req.get('X-Hasura-Role');
    authUserId = req.get('X-Hasura-User-Id');
    console.log('user Id = ', authUserId);
    if (authHeader === 'user') {
        return true;
    }
    return false;
};

app.use((req, res, next) => {
    if (validate(req)) {
        next();
    } else {
        // next();
        res.status(403).send('invalid-role');
    }
});

app.post('/checkin/request', (req, res) => {
    const chunk = req.body;
    const user1 = (chunk.from < chunk.to) ? chunk.from : chunk.to;
    const user2 = (chunk.from < chunk.to) ? chunk.to : chunk.from;
    const initiator = chunk.from;
    const receiver = chunk.to;
    const flight = chunk.flight_id;
    // const flightTime = chunk.flight_time;
    const initiatorUsername = chunk.from_username;

    const getUrl = url + '/api/1/table/flights/select';
    const getFlightOpts = {
        method: 'POST',
        body: JSON.stringify({ columns: ['number'], where: { id: flight } }),
        headers
    };

    request(getUrl, getFlightOpts, res, (resData) => {
        if (resData.length !== 1) {
            console.error(getUrl, 'Invalid response: ', resData);
            res.status(500).send('Could not fetch flights. Internal error');
            return;
        }

        // const flightNo = resData[0].number;
        const insertUrl = url + '/api/1/table/checkin/insert';
        const insertOpts = {
            method: 'POST',
            body: JSON.stringify({
                objects: [{
                    user1,
                    user2,
                    initiator,
                    flight_id: flight,
                    created: (new Date()).toISOString()
                        // ,flight_time: flightTime
                }]
            }),
            headers
        };

        request(insertUrl, insertOpts, res, () => {
            const notificationUrl = url + '/api/1/table/user/select';
            const notificationOpts = {
                method: 'POST',
                body: JSON.stringify({
                    columns: ['device_token', 'device_type'],
                    where: { id: receiver }
                }),
                headers
            };

            request(notificationUrl, notificationOpts, res, (rdata) => {
                console.log('rdata ', rdata[0]);
                const receiver = rdata[0];
                console.log('receiver: ', receiver);

                const message = {
                    to: receiver.device_token,
                    collapse_key: 'my_collapse_key',
                    priority: 'high',
                    data: {
                        from_user: initiator,
                        from_username: initiatorUsername,
                        type: 'checkin_req'
                    }
                };
                if (receiver.device_type === 'ios') {
                    message.notification = {
                        body: initiatorUsername + ' has sent you a check-in request',
                        sound: 'default',
                        badge: 1
                    };
                }
                fcm.send(message, (err, res_) => {
                    if (err) {
                        console.log('err: ', err);
                        console.log('res: ', res_);
                        console.log('Data updated, but push notification failed');
                        res.status(200).send('Data updated, but push notification failed');
                    } else {
                        console.log('Successfully sent notification with response: ' + res_ + ' to: ' + receiver.device_token);
                        res.send('All done!');
                    }
                });
            });
        });
    });
});

app.post('/checkin/update', (req, res) => {
    const chunk = req.body;
    const user1 = (chunk.from < chunk.to) ? chunk.from : chunk.to;
    const user2 = (chunk.from < chunk.to) ? chunk.to : chunk.from;
    const flight = chunk.flight_id;
    // const flightTime = chunk.flight_time;
    const from = chunk.from;
    const to = chunk.to;
    const initiatorUsername = chunk.from_username;
    const acceptStatus = (chunk.request_type === 'accepted');

    const updateData = JSON.stringify({
        $set: {
            accepted: acceptStatus
        },
        where: {
            user1,
            user2,
            flight_id: flight
                // ,flight_time: flightTime
        }
    });

    const updateUrl = url + '/api/1/table/checkin/update';
    const updateOpts = {
        method: 'POST',
        body: updateData,
        headers
    };

    request(updateUrl, updateOpts, res, () => {
        console.log('Check-in request: ' + acceptStatus.toString());
        res.send('Check-in request: ' + acceptStatus.toString());
        const notificationUrl = url + '/api/1/table/user/select';
        const notificationOpts = {
            method: 'POST',
            body: JSON.stringify({
                columns: ['device_token', 'device_type'],
                where: { id: to }
            }),
            headers
        };

        if (acceptStatus === true) {
            const mailOptions = {
                from: '"Hasura" <levotheapp@gmail.com>', // sender address
                to: 'checkin@getlevo.com', // list of receivers
                subject: 'Checkin confirmed', // Subject line
                text: 'User1: ' + user1 + ', User2: ' + user2 + ', FlightId: ' + flight, // plaintext body
                html: 'User1: ' + user1 + ', User2: ' + user2 + ', FlightId: ' + flight // html body
            };
            transporter.sendMail(mailOptions, function(error, info) {
                if (error) {
                    return console.log(error);
                }
                console.log('Email sent: ' + info.response);
            });
        }

        request(notificationUrl, notificationOpts, res, (d) => {
            const receiver = d[0];
            console.log('receiver data = ', receiver);
            if (acceptStatus === true) {
                const message = {
                    to: receiver.device_token,
                    collapse_key: 'my_collapse_key',
                    priority: 'high',
                    data: {
                        from_user: from,
                        from_username: initiatorUsername,
                        type: 'checkin_update'
                    }
                };
                if (receiver.device_type === 'ios') {
                    message.notification = {
                        body: initiatorUsername + ' has accepted your check-in request.',
                        sound: 'default',
                        badge: 1
                    };
                }
                fcm.send(message, (err, res_) => {
                    if (err) {
                        console.log('err: ', err);
                        console.log('res: ', res_);
                        console.log('Data updated, but push notification failed');
                        res.status(200).send('Data updated, but push notification failed');
                    } else {
                        console.log('Successfully sent notification with response: ' + res_ + ' to: ' + receiver.device_token);
                    }
                });
                console.log('All Done!');
            } else {
                const message = {
                    to: receiver.device_token,
                    collapse_key: 'my_collapse_key',
                    priority: 'high',
                    data: {
                        from_user: from,
                        from_username: initiatorUsername,
                        type: 'checkin_req_declined'
                    }
                };
                if (receiver.device_type === 'ios') {
                    message.notification = {
                        body: initiatorUsername + ' has declined your check-in request.',
                        sound: 'default',
                        badge: 1
                    };
                }
                fcm.send(message, (err, res_) => {
                    if (err) {
                        console.log('err: ', err);
                        console.log('res: ', res_);
                        console.log('Data updated, but push notification failed');
                        res.status(200).send('Data updated, but push notification failed');
                    } else {
                        console.log('Successfully sent notification with response: ' + res_ + ' to: ' + receiver.device_token);
                    }
                });
                console.log('All Done!');
            }
        });
    });
});

app.post('/like', (req, res) => {
    const chunk = req.body;
    const user = {
        from: chunk.from_user,
        to: chunk.to_user,
        from_username: chunk.from_username,
        to_username: chunk.to_username
    };

    const checkAlreadyLiked = JSON.stringify({
        columns: ['id', 'is_liked', 'timestamp'],
        where: {
            $and: [
                { user1: user.from },
                { user2: user.to }
            ]
        },
        order_by: [{ column: 'timestamp', order: 'desc', nulls: 'last' }],
        limit: 1
    });
    const checkAlreadyLikedUrl = url + '/api/1/table/like/select';
    const checkAlreadyLikedOpts = {
        method: 'POST',
        headers,
        body: checkAlreadyLiked
    };

    request(checkAlreadyLikedUrl, checkAlreadyLikedOpts, res, (alreadyLikedResult) => {
        let upsertUrl;
        let likeUpsert;
        const alreadyLiked = (alreadyLikedResult.length !== 0) ? (alreadyLikedResult[0].is_liked) : false;
        console.log('alreadyLikedResult: ', alreadyLikedResult);
        if (alreadyLikedResult.length === 0) {
            console.log('inserting...');
            upsertUrl = url + '/api/1/table/like/insert';
            likeUpsert = JSON.stringify({
                objects: [{
                    user1: user.from,
                    user2: user.to,
                    is_liked: true
                }]
            });
        } else {
            console.log('updating...');
            upsertUrl = url + '/api/1/table/like/update';
            likeUpsert = JSON.stringify({
                $set: { is_liked: true, timestamp: (new Date()).toISOString() },
                where: { id: alreadyLikedResult[0].id }
            });
        }

        const upsertOpts = {
            method: 'POST',
            headers,
            body: likeUpsert
        };

        request(upsertUrl, upsertOpts, res, () => {
            const twoWayConnectionCheck = JSON.stringify({
                columns: ['is_liked', 'timestamp'],
                where: {
                    $and: [
                        { user1: user.to },
                        { user2: user.from }
                    ]
                },
                order_by: [{ column: 'timestamp', order: 'desc', nulls: 'last' }],
                limit: 1
            });

            console.log(twoWayConnectionCheck);
            const twoWayConnectionCheckUrl = url + '/api/1/table/like/select';
            const twoWayConnectionCheckOpts = {
                method: 'POST',
                headers,
                body: twoWayConnectionCheck
            };

            request(twoWayConnectionCheckUrl, twoWayConnectionCheckOpts, res, (twoWayResult) => {
                let notificationType;

                const notificationTitleBody = { body: 'Click here to view', sound: 'default', badge: 1 };

                if (twoWayResult.length === 0) {
                    notificationType = 'conn_req';
                    notificationTitleBody.body = user.from_username + ' has sent you a connection request.';
                } else if (twoWayResult[0].is_liked) {
                    if (alreadyLiked) {
                        notificationType = 'conn_req_existing';
                        notificationTitleBody.body = user.from_username + ' is travelling at the same time as you';
                    } else {
                        notificationType = 'conn_estd';
                        notificationTitleBody.body = user.from_username + ' is now a connection!';
                        // body set where fcm.send is called
                    }
                } else {
                    notificationType = 'conn_req';
                    notificationTitleBody.body = user.from_username + ' has sent you a connection request.';
                }

                const notificationData = {
                    columns: ['device_token', 'device_type'],
                    where: { id: user.to }
                };

                const notificationUrl = url + '/api/1/table/user/select';
                const notificationOpts = {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(notificationData)
                };

                request(notificationUrl, notificationOpts, res, (notificationRes) => {
                    const receiver = notificationRes[0];
                    const message = {
                        to: receiver.device_token,
                        collapse_key: 'my_collapse_key',
                        priority: 'high',
                        data: {
                            from_user: user.from,
                            from_username: user.from_username,
                            type: notificationType
                        }
                    };

                    if (receiver.device_type === 'ios') {
                        if (notificationType === 'conn_req_existing') {
                            notificationTitleBody.body = user.from_username + ' is travelling the same time as you';
                        }
                        message.notification = notificationTitleBody;
                    }

                    fcm.send(message, (err, result) => {
                        if (err) {
                            console.log('Error in sending FCM notification: ', err);
                            console.log('Message to be sent: ', JSON.stringify(message));
                            console.log('res: ', result);
                            return;
                        }
                        console.log('Successfully sent notification with response: ' + res + 'to: ' + receiver.device_token);
                    });

                    if (notificationType === 'conn_estd') {
                        notificationData.where.id = user.from;
                        notificationOpts.body = JSON.stringify(notificationData);
                        notificationTitleBody.body = user.from_username + ' is travelling the same time as you';

                        request(notificationUrl, notificationOpts, res, (notification2Res) => {
                            const receiver2 = notification2Res[0];
                            const message2 = {
                                to: receiver2.device_token,
                                collapse_key: 'my_collapse_key',
                                priority: 'high',
                                data: {
                                    from_user: user.to,
                                    from_username: user.to_username,
                                    type: notificationType
                                }
                            };

                            if (receiver2.device_type === 'ios') {
                                message.notification = notificationTitleBody;
                            }

                            fcm.send(message2, (err, result) => {
                                if (err) {
                                    console.log('Error in sending FCM notification: ', err);
                                    console.log('Message to be sent: ', JSON.stringify(message2));
                                    console.log('res: ', result);
                                    res.status(500).send('Internal error');
                                    return;
                                }
                                res.send('Succesfully sent notifications!');
                            });
                        });
                    } else {
                        res.send('Notifications sent!');
                    }
                });
            });
        });
    });
});

app.get('/linkedin-profile/:token', (req, res) => {
    const profileUrl = 'https://api.linkedin.com/v1/people/~:(positions,email-address,formatted-name,phone-numbers,picture-urls::(original))?format=json';
    const profileOpts = {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + req.params.token }
    };
    request(profileUrl, profileOpts, res, (data) => {
        res.set('Content-Type', 'application/json');
        res.send(JSON.stringify(data));
    });
});

app.post('/mutual-friends', (req, res) => {
    const input = req.body;
    console.log(input);
    const url = `https://graph.facebook.com/v2.8/${input.otherId}?fields=context.fields%28all_mutual_friends.limit%28100%29%29&access_token=${input.userToken}`;
    const options = {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + input.myToken
        }
    };
    request(url, options, res, (data) => {
        console.log(JSON.stringify(data));
        res.set('Content-Type', 'application/json');
        res.send(JSON.stringify(data));
    });
});


app.post('/flight-check', (req, res) => {
    const input = req.body;

    var flightCode = input.flight_number.substring(0, 2);
    var flightNumber = input.flight_number.substring(2);
    var d = new Date(input.today_date);
    var departYear = d.getFullYear();
    var departMonth = d.getMonth() + 1;
    var departDay = d.getDate();
    const getUrl = `https://data.stellar60.hasura-app.io/v1/template/get_flights?today_date=${input.today_date}&tomorrow_date=${input.tomorrow_date}&flight_number=${input.flight_number}`
    const getFlightOpts = {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer bgxmb0a2tf4gbzl7w4p74sv7jhf0xkl0',
            'X-Hasura-Role': 'user'
        }
    };
    request(getUrl, getFlightOpts, res, (resData) => {

        if (resData.length < 1) {
            const url1 = `https://api.flightstats.com/flex/schedules/rest/v1/json/flight/${flightCode}/${flightNumber}/departing/${departYear}/${departMonth}/${departDay}?appId=7c7b6a76&appKey=40a9cba98bd34a470328391666ce9df8`;
            const options = {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            };
            request(url1, options, res, (data) => {
                var airline = data.appendix.airlines;
                var flightName = "";
                var airports = data.appendix.airports;
                var flights = data.scheduledFlights;
                var depCode = flights[0].departureAirportFsCode;
                var destination = airports[0].city;
                var depTime = flights[0].departureTime.substring(0, flights[0].departureTime.indexOf('.'))
                depTime = depTime+'Z';

                var origin = airports[airports.length - 1].city;
                if (flights.length == 1) {
                    var arrCode = flights[0].arrivalAirportFsCode;
                    // var arrTime = new Date(flights[0].arrivalTime).toISOString();
                    var arrTime = flights[0].arrivalTime.substring(0, flights[0].arrivalTime.indexOf('.'))
                    arrTime = arrTime+'Z';

                } else {
                    var arrCode = flights[flights.length - 1].arrivalAirportFsCode;
                    // var arrTime = new Date(flights[flights.length - 1].arrivalTime);
                    var arrTime = flights[flights.length - 1].arrivalTime.substring(0, flights[flights.length - 1].arrivalTime.indexOf('.'))
                    arrTime = arrTime+'Z';
                }
                for (var i = 0; i < airline.length; i++) {
                    if (airline[i].fs == flightCode) {
                        flightName = airline[i].name;
                    }
                }

                const insertUrl = 'https://data.stellar60.hasura-app.io/api/1/table/flights/insert';
                const insertOpts = {
                    method: 'POST',
                    body: JSON.stringify({
                        objects: [{

                            number: input.flight_number,
                            airline: flightName,
                            origin_code: depCode,
                            destination_code: arrCode,
                            departure: depTime,
                            arrival: arrTime,
                            origin: origin,
                            destination: destination,
                            op_days:"444"
                        }]
                    }),
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer bgxmb0a2tf4gbzl7w4p74sv7jhf0xkl0',
                        'X-Hasura-Role': 'admin'
                    }
                };
                // console.log(insertOpts.body);
                request(insertUrl, insertOpts, res, (resData) => {

                    const getUrl = `https://data.stellar60.hasura-app.io/v1/template/get_flights?today_date=${input.today_date}&tomorrow_date=${input.tomorrow_date}&flight_number=${input.flight_number}`
                    const getFlightOpts = {
                        method: 'GET',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer bgxmb0a2tf4gbzl7w4p74sv7jhf0xkl0',
                            'X-Hasura-Role': 'user'
                        }
                    };
                    request(getUrl, getFlightOpts, res, (resData) => {

                        res.send(resData);
                    })
                });
            });
        } else {
            res.send(resData);
        }
    });
});


app.post('/send-feedback', (req, res) => {
    const chunk = req.body;
    // const userid = chunk.user_id;
    const usermail = chunk.usermail;
    const feedbackmsg = chunk.feedback_msg;
    // console.log('response =', res);
    res.send(mail.sendmail(usermail, feedbackmsg));
});

app.post('/appversion', (req, res) => {
    // const appcurrentversion = '1.0';
    const version = req.body.version;
    const message = 'OK';
    console.log('version =', version);
    const response = {
        appversion: '1.0',
        msg: message
    };
    if (version === androidversion) {
        res.set('Content-Type', 'application/json');
        res.status(200).send(JSON.stringify(response));
    } else {
        response.msg = 'Force Update';
        res.set('Content-Type', 'application/json');
        res.status(200).send(JSON.stringify(response));
    }
});

const sockets = {};
io.on('connection', (socket) => {
    console.log('User connected: ' + socket.id);

    if (socket.handshake.headers['x-hasura-user-role'] === 'anonymous') {
        return;
    }

    const userId = socket.handshake.headers['x-hasura-user-id'];
    sockets[userId] = socket;
    console.log('Socket handshake accepted from: ' + userId.toString());

    socket.on('chat message', (_params) => {
        // DEBUG
        // console.log(socket.handshake.headers);
        try {
            const params = JSON.parse(_params);
            params.from = parseInt(userId, 10);

            const senderUsername = params.from_username;
            const msg = params.message;
            const user = { from: params.from, to: params.to };
            const chattimestamp = params.timeStamp;

            const connectionCheckData = {
                columns: ['*'],
                where: {
                    $or: [
                        { $and: [{ user1: user.from }, { user2: user.to }] },
                        { $and: [{ user1: user.to }, { user2: user.from }] }
                    ]
                }
            };

            const connectionCheckUrl = url + '/api/1/table/connections/select';
            const connectionCheckOpts = {
                method: 'POST',
                headers,
                body: JSON.stringify(connectionCheckData)
            };

            request(connectionCheckUrl, connectionCheckOpts, null, (checkResult) => {
                if (checkResult === 0) {
                    socket.emit('chat message', 'You don\'t have a connection with user');
                } else {
                    const user1 = (user.from < user.to) ? user.from : user.to;
                    const user2 = (user.from < user.to) ? user.to : user.from;
                    // const chattimestamp = (new Date()).toISOString();
                    const messageInsertData = JSON.stringify({
                        objects: [{
                            user1,
                            user2,
                            sender: user.from,
                            text: msg,
                            timestamp: chattimestamp
                        }]
                    });

                    const messageInsertUrl = url + '/api/1/table/message/insert';
                    const messageInsertOpts = {
                        method: 'POST',
                        headers,
                        body: messageInsertData
                    };

                    request(messageInsertUrl, messageInsertOpts, null, () => {
                        console.log('message:' + msg);
                        if (sockets[user.to]) {
                            const toSocket = sockets[user.to];
                            toSocket.emit('chat message', JSON.stringify({
                                from_user: user.from,
                                from_username: senderUsername,
                                message: msg,
                                timeStamp: chattimestamp
                            }));
                        } else { // No socket for the to user active at the moment
                            const tokenData = {
                                columns: ['device_token', 'device_type'],
                                where: { id: user.to }
                            };
                            const getTokenUrl = url + '/api/1/table/user/select';
                            const getTokenOpts = {
                                method: 'POST',
                                headers,
                                body: JSON.stringify(tokenData)
                            };

                            request(getTokenUrl, getTokenOpts, null, (tokenResult) => {
                                const receiver = tokenResult[0];
                                const message = {
                                    to: receiver.device_token,
                                    collapse_key: 'my_collapse_key',
                                    priority: 'high',
                                    data: {
                                        from_user: user.from,
                                        from_username: senderUsername,
                                        message: msg,
                                        type: 'chat-notif'
                                    }
                                };
                                if (receiver.device_type === 'ios') {
                                    message.notification = {
                                        title: senderUsername,
                                        body: msg,
                                        sound: 'default',
                                        badge: 1
                                    };
                                }

                                fcm.send(message, (err, res) => {
                                    if (err) {
                                        console.log('err: ', err);
                                        console.log('res: ', res);
                                        console.log('Something has gone wrong!');
                                    } else {
                                        console.log('Successfully sent with response: ', res);
                                    }
                                });
                            });
                        }
                    });
                }
            });
        } catch (e) {
            console.error(e);
            console.error(e.stack);
            console.error('Some error in the "chat message" event');
        }
    });

    socket.on('disconnect', () => {
        if (userId) {
            sockets[userId] = null;
            console.log('User: ' + userId + ' disconnected');
        }
    });
});


// Listen at the server
if (config.port) {
    server.listen(config.port, config.host, (err) => {
        if (err) {
            console.error(err);
        }
        console.info('----\n==> ✅  %s is running, talking to API server.', config.app.title);
        console.info('==> 💻  Open http://%s:%s in a browser to view the app.', config.host, config.port);
    });
} else {
    console.error('==>     ERROR: No PORT environment variable has been specified');
}
