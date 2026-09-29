const EVENT_MAPPINGS = {
  "Financial Planning & Profitability Seminar": [
    "financial planning & profitability seminar",
    "financial planning & profitability seminar - dr.",
    "financial planning & profitability seminar – om"
  ]
};

const itemName = "financial planning & profitability seminar - dr.";
const services = "florida | financial planning & profitability seminar | 2/18-2/20";
let matched = false;

for (const title in EVENT_MAPPINGS) {
    const variants = EVENT_MAPPINGS[title];
    console.log("Checking variants:", variants);
    if (variants.some(v => v.includes(itemName) || itemName.includes(v))) {
        console.log("Belongs to group!");
        if (variants.some(v => services.includes(v.replace(/- in person only/g, '').replace(/livestream/g, '').trim()))) {
            console.log("PDF contains variant!");
            matched = true;
            break;
        } else {
            console.log("PDF DOES NOT CONTAIN VARIANT!");
        }
    }
}
console.log(matched);
