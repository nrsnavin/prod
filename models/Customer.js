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
        
    },
    { timestamps: true }
);

const Customer = mongoose.model("Customer", CustomerSchema);
module.exports = Customer;