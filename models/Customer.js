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