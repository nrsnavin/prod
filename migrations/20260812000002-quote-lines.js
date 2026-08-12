'use strict';
//
// Move single-product quotations onto the lines[] shape.
//
// The first version of the quotation carried ONE product, with its name,
// its materials and its costing at the top level of the document. A
// quotation covers several widths in practice, so the product moved into
// a `lines` array and the money that used to sit beside it became a
// document total.
//
// Existing quotes have to come with it. A quote that stays in the old
// shape reads as a quote with NO products: the detail page renders an
// empty table, the PDF prints no rows, and the totals show zero — a
// document that silently loses its contents rather than failing loudly.
//
// The costing is moved, not recomputed. These are prices that were sent
// to customers at the yarn costs of the day; recalculating them here
// would restate history at today's costs, which is the one thing the
// frozen costing exists to prevent.
//
// The rate on the old shape was already quoted in paise, so the line
// totals it produces are the ones the customer was given.
//
// Down: folds the first line back to the top level. A quote that gained
// further products after the migration keeps only its first on the way
// back, which is as much as the old shape can hold — noted rather than
// silently truncated.

module.exports = {
  async up(db) {
    const quotes = db.collection('quotes');
    const cursor = quotes.find({
      productName: { $exists: true },
      $or: [{ lines: { $exists: false } }, { lines: { $size: 0 } }],
    });

    let moved = 0;
    for await (const q of cursor) {
      const line = {
        elastic:        q.elastic,
        productName:    q.productName || 'Product',
        productSpec:    q.productSpec || '',
        materials:      Array.isArray(q.materials) ? q.materials : [],
        conversionCost: q.conversionCost || 0,
        marginPercent:  q.marginPercent  || 0,
        quantityMetres: q.quantityMetres || 0,

        totalWeightGrams: q.totalWeightGrams || 0,
        materialCost:     q.materialCost     || 0,
        totalCost:        q.totalCost        || 0,
        marginAmount:     q.marginAmount     || 0,
        rateBeforeTax:    q.rateBeforeTax    || 0,
        gstAmount:        q.gstAmount        || 0,
        rateInclTax:      q.rateInclTax      || 0,
        valueBeforeTax:   q.valueBeforeTax   || 0,
        valueInclTax:     q.valueInclTax     || 0,
      };

      await quotes.updateOne(
        { _id: q._id },
        {
          $set: {
            lines: [line],
            subTotal:            q.valueBeforeTax || 0,
            gstAmount:           (q.valueInclTax || 0) - (q.valueBeforeTax || 0),
            grandTotal:          q.valueInclTax  || 0,
            totalQuantityMetres: q.quantityMetres || 0,
          },
          $unset: {
            elastic: '', productName: '', productSpec: '', materials: '',
            conversionCost: '', marginPercent: '', quantityMetres: '',
            totalWeightGrams: '', materialCost: '', totalCost: '',
            marginAmount: '', rateBeforeTax: '', rateInclTax: '',
            valueBeforeTax: '', valueInclTax: '',
          },
        }
      );
      moved += 1;
    }

    // eslint-disable-next-line no-console
    console.log(`[quote-lines] moved ${moved} quotation(s) onto lines[]`);
  },

  async down(db) {
    const quotes = db.collection('quotes');
    const cursor = quotes.find({ 'lines.0': { $exists: true } });

    let folded = 0;
    let truncated = 0;
    for await (const q of cursor) {
      const [first] = q.lines;
      if (q.lines.length > 1) truncated += 1;
      await quotes.updateOne(
        { _id: q._id },
        {
          $set: {
            elastic: first.elastic,
            productName: first.productName,
            productSpec: first.productSpec,
            materials: first.materials,
            conversionCost: first.conversionCost,
            marginPercent: first.marginPercent,
            quantityMetres: first.quantityMetres,
            totalWeightGrams: first.totalWeightGrams,
            materialCost: first.materialCost,
            totalCost: first.totalCost,
            marginAmount: first.marginAmount,
            rateBeforeTax: first.rateBeforeTax,
            rateInclTax: first.rateInclTax,
            valueBeforeTax: first.valueBeforeTax,
            valueInclTax: first.valueInclTax,
          },
          $unset: { lines: '', subTotal: '', grandTotal: '', totalQuantityMetres: '' },
        }
      );
      folded += 1;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[quote-lines] down: folded ${folded} quotation(s); ` +
      `${truncated} had more than one product and kept only the first`
    );
  },
};
