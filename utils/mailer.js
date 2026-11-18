// Transport + the two account emails are shared. Any template about YOUR
// domain — invoices, receipts, reminders — belongs in this file, not the
// package. Copying templates between apps is what this whole core exists to
// stop.
const nodemailer = require('nodemailer');
const { getSettings } = require('./settings');
const { logNotification } = require('./notifications');

module.exports = require('@deontech/notify').createMailer({ nodemailer, getSettings, logNotification });
