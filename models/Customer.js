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
            required: true,
            default: "",
            max: 50,
        },
        gstin: {
            type: String,
            default: "",
        },
        status: {
            type: String,
            required: true,
            default: "Inactive",
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
        handledBy: {
            type: mongoose.Types.ObjectId,
            ref: "User",
            required: true,
            default: "674094bc34142bb04850c005",
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
        transporter: {
            type: {},
        },
        transactions: [],
        products: [{
            id: {
                type: mongoose.Types.ObjectId,
                ref: "Elastic"
            },
        }],
        orders: [{
            id: {
                type: mongoose.Types.ObjectId,
                ref: "Order"
            },
        }],
        
    },
    { timestamps: true }
);

const Customer = mongoose.model("Customer", CustomerSchema);
module.exports = Customer;