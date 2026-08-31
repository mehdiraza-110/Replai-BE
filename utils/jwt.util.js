const jwt = require("jsonwebtoken");
require('dotenv').config();

exports.verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET);

exports.createToken = async (data) => jwt.sign(data, process.env.JWT_SECRET, { expiresIn: '1h' });