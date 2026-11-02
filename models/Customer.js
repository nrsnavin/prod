const mongoose = require("mongoose");


const CustomerSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            min: 2,
            max: 100,
        },
        email: {
            type: String,
            
            default: "",
            max: 50,
        },
        gstin: {
            type: String,
            default: "",
        },

        // ── Soft delete ──────────────────────────────────────────────
        // A customer is never removed: their orders, delivery challans
        // and ledger rows keep pointing at them, and a deleted record
        // would leave that history unreadable. Archiving hides them
        // from lists and pickers instead — a display filter, not a
        // deletion. Legacy documents have no key, so every filter reads
        // `{ archived: { $ne: true } }` rather than `{ archived: false }`.
        //
        // Mirrors Elastic.archived, deliberately: two soft deletes with
        // different shapes is how one of them ends up forgotten.
        archived:   { type: Boolean, default: false, index: true },
        // The factory itself, as the customer of a restock order
        // (POST /order/restock): making an elastic for its own stock goes
        // through the same order → job flow as making it for a buyer.
        houseStock: { type: Boolean, default: false, index: true },
        archivedAt: { type: Date },
        status: {
            type: String,
            required: true,
            default: "Active",
        },
        contactName: {
            type: String,
            required: true,
            default: "",
        },
        phoneNumber: {
            type: String,
            required: true,
            default: "",
        },
        // Billing address — printed on challans and invoices, and the
        // buyer block of an e-invoice (Addr1 / Loc / Pin / Stcd).
        address: { type: String, default: "" },
        city: { type: String, default: "" },
        pincode: { type: String, default: "" },
        // Two-digit GST state code; derived from the GSTIN when blank.
        stateCode: { type: String, default: "" },

        purchase: {
            type: {
                name: {
                    type: String,
                },
                mobile: {
                    type: String,
                },
                email: {
                    type: String,
                },
            }
        },
        accountant: {
            type: {
                name: {
                    type: String,
                },
                mobile: {
                    type: String,
                },
                email: {
                    type: String,
                },
            }
        },
        merchandiser: {
            type: {
                name: {
                    type: String,
                },
                mobile: {
                    type: String,
                },
                email: {
                    type: String,
                },
            }
        },
        paymentTerms: {
            type: String,
            required: true,
            default: "30"
        },
        // Credit control (services/creditControl.js): 0 = no limit.
        creditLimit:    { type: Number, default: 0, min: 0 },
        maxOverdueDays: { type: Number, default: 0, min: 0 },
        
    },
    { timestamps: true }
);

const Customer = mongoose.model("Customer", CustomerSchema);
module.exports = Customer;