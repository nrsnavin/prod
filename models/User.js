const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      min: 2,
      max: 100,
      required: [true, "Please enter your name!"],
    },
    email: {
      type: String,
      required: [true, "Please enter your email!"],
      max: 50,
      unique: true,
    },
    password: {
      type: String,
      required: [true, "Please enter your password"],
      minLength: [4, "Password should be greater than 4 characters"],
      select: false,
    },
    role: {
      type: String,
      required: true,
    },
    // Shop-floor department that drives the web app's nav + route access
    // (preparatory / weaving / packing / finance / admin). The coarser
    // `role` above is DERIVED from this (see utils/roles.js) and is what
    // the backend RBAC gates enforce. Optional so pre-existing users
    // (which only carry `role`) remain valid.
    department: {
      type: String,
      enum: ["admin", "preparatory", "weaving", "packing", "finance"],
    },
    // Optional link to the Employee document. Set on User creation
    // for any user that's also a workforce member, so the mobile
    // employee app can look up their wastage / shift / payroll
    // records via this id without an extra query.
    employee: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
    },
  },
  { timestamps: true }
);

userSchema.pre("save", async function (next){
  if(!this.isModified("password")){
    next();
  }

  this.password = await bcrypt.hash(this.password, 10);
});

// jwt token
userSchema.methods.getJwtToken = function () {
  return jwt.sign({ id: this._id,role:this.role,name:this.name,email:this.email}, process.env.JWT_SECRET_KEY,{
    expiresIn: process.env.JWT_EXPIRES,
  });
};

// compare password
userSchema.methods.comparePassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.model("User", userSchema);
module.exports=User;

