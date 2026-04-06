/**
 * utils/phone.js
 * Nigerian phone number normalisation.
 *
 * Meta WhatsApp sends: 2348012345678 (no +, no spaces)
 * Users register with: 08012345678 / +2348012345678 / 234 801 234 5678 / 8012345678
 *
 * normalizePhone() converts ALL formats to: 2348012345678
 * so DB lookups always match regardless of how the number was entered.
 */

'use strict';

/**
 * Convert any Nigerian phone format to the canonical 234XXXXXXXXXX format.
 * @param {string|number} phone
 * @returns {string} e.g. "2348012345678"
 */
function normalizePhone(phone) {
  if (!phone) return '';

  // Strip spaces, dashes, brackets, + sign
  let cleaned = String(phone).replace(/[\s\-\(\)\+]/g, '');

  // Remove leading zeros
  cleaned = cleaned.replace(/^0+/, '');

  // Already has country code
  if (cleaned.startsWith('234')) return cleaned;

  // Nigerian mobile without country code — starts with 7, 8, or 9 and is 10 digits
  if (/^[789]\d{9}$/.test(cleaned)) return '234' + cleaned;

  // Return as-is (international numbers from other countries)
  return cleaned;
}

module.exports = { normalizePhone };
