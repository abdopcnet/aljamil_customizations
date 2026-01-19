// Copyright (c) 2025, Aljamil Customizations
// For license information, please see license.txt

// Frontend logging: console.log('[landed_cost_voucher.js] method: function_name')

// Custom JavaScript for Landed Cost Voucher
frappe.provide("aljamil_customizations.landed_cost_voucher");

// Extend Landed Cost Voucher class
frappe.ui.form.on("Landed Cost Voucher", {
    refresh: function(frm) {
        // Add button to create Purchase Invoices from supplier expenses
        if (frm.doc.docstatus === 0) {
            frm.add_custom_button(
                __("Create Cost Invoice"),
                function() {
                    aljamil_customizations.landed_cost_voucher.create_purchase_invoices(frm);
                }
            );
        }
    },

    validate: function(frm) {
        // Clear fields to prevent mandatory field errors
        if (frm.doc.taxes) {
            let needs_refresh = false;
            frm.doc.taxes.forEach(function(tax, index) {
                // Convert checkbox to integer for comparison
                let is_checked = cint(tax.custom_expense_from_supplier) === 1;
                let has_supplier = tax.custom_expense_supplier;

                // If checkbox is checked but supplier is empty, uncheck checkbox
                if (is_checked && !has_supplier) {
                    tax.custom_expense_from_supplier = 0;
                    needs_refresh = true;
                }
                // If checkbox is unchecked, ensure supplier is cleared
                if (!is_checked) {
                    if (has_supplier) {
                        tax.custom_expense_supplier = null;
                        needs_refresh = true;
                    }
                }
            });

            // Refresh taxes table if any changes were made
            if (needs_refresh) {
                frm.refresh_field("taxes");
            }
        }
    }
});

// Function to create Purchase Invoices
aljamil_customizations.landed_cost_voucher.create_purchase_invoices = function(frm) {
    // Validate required fields and check if Purchase Invoice already exists
    var missing_fields = [];
    var already_has_invoices = [];

    if (frm.doc.taxes) {
        frm.doc.taxes.forEach(function(tax) {
            // Only check rows with custom_expense_from_supplier == 1
            if (tax.custom_expense_from_supplier) {
                // Check if Purchase Invoice already exists
                if (tax.custom_expense_purchase_invoice) {
                    already_has_invoices.push(__("Row {0}: Purchase Invoice {1} already exists",
                        [tax.idx, tax.custom_expense_purchase_invoice]));
                }

                // Check required fields only if no Purchase Invoice exists
                if (!tax.custom_expense_purchase_invoice) {
                    if (!tax.custom_expense_supplier) {
                        missing_fields.push(__("Row {0}: Supplier is required", [tax.idx]));
                    }
                    if (!tax.custom_service_item) {
                        missing_fields.push(__("Row {0}: Service Item is required", [tax.idx]));
                    }
                    if (!tax.amount && !tax.base_amount) {
                        missing_fields.push(__("Row {0}: Amount is required", [tax.idx]));
                    }
                }
            }
        });
    }

    // Check if there are any rows that need Purchase Invoice creation
    var has_rows_to_process = false;
    if (frm.doc.taxes) {
        has_rows_to_process = frm.doc.taxes.some(function(tax) {
            return tax.custom_expense_from_supplier &&
                   !tax.custom_expense_purchase_invoice;
        });
    }

    // If all rows already have Purchase Invoices, show message
    if (!has_rows_to_process && already_has_invoices.length > 0) {
        frappe.msgprint({
            title: __("Purchase Invoices Already Created"),
            message: already_has_invoices.join("<br>"),
            indicator: "blue"
        });
        return;
    }

    if (missing_fields.length > 0) {
        frappe.msgprint({
            title: __("Missing Required Fields"),
            message: missing_fields.join("<br>"),
            indicator: "red"
        });
        return;
    }

    // Confirm action
    frappe.confirm(
        __("Are you sure you want to create Purchase Invoices for supplier expenses?"),
        function() {
            // Yes, proceed
            frappe.call({
                method: "aljamil_customizations.landed_cost_voucher.create_purchase_invoices_from_expenses",
                args: {
                    doc_name: frm.doc.name
                },
                freeze: true,
                freeze_message: __("Creating Purchase Invoices..."),
                callback: function(r) {
                    if (r.message) {
                        var msg = "";

                        if (r.message.created_invoices && r.message.created_invoices.length > 0) {
                            msg += "<div style='margin-top: 10px;'>";
                            msg += "<h4 style='color: green; margin-bottom: 10px;'>" + __("Created Purchase Invoices:") + "</h4>";
                            msg += "<table class='table table-bordered' style='margin-bottom: 0; table-layout: auto; width: 100%;'>";
                            msg += "<thead><tr>";
                            msg += "<th style='white-space: nowrap; padding: 8px;'>" + __("Invoice") + "</th>";
                            msg += "<th style='white-space: nowrap; padding: 8px;'>" + __("Supplier") + "</th>";
                            msg += "<th style='white-space: nowrap; padding: 8px; text-align: center;'>" + __("Items") + "</th>";
                            msg += "<th style='white-space: nowrap; padding: 8px; text-align: right;'>" + __("Amount") + "</th>";
                            msg += "</tr></thead>";
                            msg += "<tbody>";
                            r.message.created_invoices.forEach(function(inv) {
                                var formatted_amount = inv.total_amount;
                                try {
                                    if (typeof format_currency === 'function') {
                                        formatted_amount = format_currency(inv.total_amount, frm.doc.company);
                                    } else if (typeof frappe.format !== 'undefined') {
                                        formatted_amount = frappe.format(inv.total_amount, {
                                            fieldtype: "Currency",
                                            options: frm.doc.company
                                        });
                                    }
                                } catch(e) {
                                    // Use raw amount if formatting fails
                                }

                                var invoice_link = frappe.utils.get_form_link(
                                    "Purchase Invoice",
                                    inv.invoice,
                                    true,
                                    inv.invoice
                                );
                                msg += "<tr>";
                                msg += "<td style='white-space: nowrap; padding: 8px;'>" + invoice_link + "</td>";
                                msg += "<td style='white-space: nowrap; padding: 8px;'>" + inv.supplier + "</td>";
                                msg += "<td style='white-space: nowrap; padding: 8px; text-align: center;'>" + inv.items_count + "</td>";
                                msg += "<td style='white-space: nowrap; padding: 8px; text-align: right;'>" + formatted_amount + "</td>";
                                msg += "</tr>";
                            });
                            msg += "</tbody></table>";
                            msg += "</div>";
                        }

                        if (r.message.errors && r.message.errors.length > 0) {
                            msg += "<div style='margin-top: 15px;'>";
                            msg += "<h4 style='color: red; margin-bottom: 10px;'>" + __("Errors:") + "</h4>";
                            msg += "<table class='table table-bordered' style='margin-bottom: 0; table-layout: auto; width: 100%;'>";
                            msg += "<thead><tr>";
                            msg += "<th style='white-space: nowrap; padding: 8px;'>" + __("Supplier") + "</th>";
                            msg += "<th style='white-space: nowrap; padding: 8px;'>" + __("Error") + "</th>";
                            msg += "</tr></thead>";
                            msg += "<tbody>";
                            r.message.errors.forEach(function(err) {
                                msg += "<tr>";
                                msg += "<td style='white-space: nowrap; padding: 8px;'>" + err.supplier + "</td>";
                                msg += "<td style='white-space: nowrap; padding: 8px; color: red;'>" + err.error + "</td>";
                                msg += "</tr>";
                            });
                            msg += "</tbody></table>";
                            msg += "</div>";
                        }

                        frappe.msgprint({
                            title: __("Purchase Invoices Created"),
                            message: msg,
                            indicator: r.message.errors && r.message.errors.length > 0 ? "orange" : "green"
                        });

                        // Refresh form to show new Purchase Invoice references
                        frm.reload_doc();
                    }
                },
                error: function(r) {
                    frappe.msgprint({
                        title: __("Error"),
                        message: r.message || __("An error occurred while creating Purchase Invoices"),
                        indicator: "red"
                    });
                }
            });
        },
        function() {
            // No, cancel
        }
    );
};
