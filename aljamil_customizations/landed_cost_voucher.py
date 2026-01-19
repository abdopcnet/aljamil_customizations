import frappe
from frappe import _
from frappe.utils import flt, today, getdate, cint
import erpnext
import json
from erpnext.accounts.party import get_party_account
from erpnext.setup.utils import get_exchange_rate
from erpnext.controllers.taxes_and_totals import get_itemised_tax


# Journal Entry functions removed - Purchase Invoice handles GL entries now


def validate_landed_cost_voucher_taxes(doc, method):
    """
    Validate and clean custom_expense_supplier field in taxes table.
    Ensures that if custom_expense_from_supplier is unchecked, custom_expense_supplier is cleared.
    """
    if not doc.get("taxes"):
        return

    for tax_row in doc.get("taxes"):
        is_checked = cint(tax_row.get("custom_expense_from_supplier")) == 1
        has_supplier = tax_row.get("custom_expense_supplier")

        # If checkbox is unchecked, ensure supplier is cleared
        if not is_checked and has_supplier:
            tax_row.custom_expense_supplier = None

        # If checkbox is checked but supplier is empty, this will be caught by mandatory validation
        # We don't uncheck it here to let the user see the error


@frappe.whitelist()
def create_purchase_invoices_from_expenses(doc_name):
    """
    Create Purchase Invoices for supplier expenses in Landed Cost Voucher.
    Groups expenses by supplier and creates one Purchase Invoice per supplier.
    """
    doc = frappe.get_doc("Landed Cost Voucher", doc_name)

    if not doc.get("taxes"):
        frappe.throw(_("No taxes and charges found in this document"))

    # Group expenses by supplier and currency
    # Key: (supplier, currency)
    supplier_expenses = {}

    company_currency = erpnext.get_company_currency(doc.company)

    for tax_row in doc.get("taxes"):
        # Only process rows with custom_expense_from_supplier == 1
        # Use cint() to properly check checkbox value
        if not cint(tax_row.get("custom_expense_from_supplier")) == 1:
            continue

        # Skip if Purchase Invoice already exists
        if tax_row.get("custom_expense_purchase_invoice"):
            continue

        supplier = tax_row.get("custom_expense_supplier")
        service_item = tax_row.get("custom_service_item")
        amount = flt(tax_row.get("amount") or tax_row.get("base_amount"))

        # Get currency from account_currency field, fallback to company currency
        account_currency = tax_row.get("account_currency") or company_currency

        if not supplier:
            frappe.throw(
                _("Row {0}: Supplier is required when 'Expense From Supplier' is checked").format(
                    tax_row.idx
                )
            )

        if not service_item:
            frappe.throw(
                _("Row {0}: Service Item is required when 'Expense From Supplier' is checked").format(
                    tax_row.idx
                )
            )

        if not amount:
            continue

        # Group by (supplier, currency) tuple
        key = (supplier, account_currency)
        if key not in supplier_expenses:
            supplier_expenses[key] = []

        supplier_expenses[key].append({
            "tax_row": tax_row,
            "service_item": service_item,
            "amount": amount,
            "base_amount": flt(tax_row.get("base_amount") or amount),
            "description": tax_row.get("description") or "",
            "row_idx": tax_row.idx,
            "account_currency": account_currency,
            "warehouse": tax_row.get("custom_supplier_warehouse")
        })

    # Don't throw error if no supplier expenses - just return empty result
    # This allows the function to be called even when there are no supplier expenses
    if not supplier_expenses:
        return {
            "created_invoices": [],
            "errors": []
        }

    created_invoices = []
    errors = []

    for key, expenses in supplier_expenses.items():
        supplier, currency = key

        try:
            # Get supplier account
            supplier_account = get_party_account("Supplier", supplier, doc.company)
            if not supplier_account:
                errors.append({
                    "supplier": supplier,
                    "error": _("Supplier Account not found")
                })
                continue

            # Get exchange rate if currency is different from company currency
            if currency != company_currency:
                exchange_rate = get_exchange_rate(
                    from_currency=currency,
                    to_currency=company_currency,
                    transaction_date=doc.posting_date or today(),
                    args="for_buying"
                ) or 1.0
            else:
                exchange_rate = 1.0

            # Get original Purchase Invoice from purchase_receipts
            # Use first Purchase Invoice found in purchase_receipts
            original_purchase_invoice = None
            if doc.get("purchase_receipts"):
                for pr_row in doc.get("purchase_receipts"):
                    if pr_row.receipt_document_type == "Purchase Invoice" and pr_row.receipt_document:
                        original_purchase_invoice = pr_row.receipt_document
                        break

            # Create Purchase Invoice
            purchase_invoice = frappe.new_doc("Purchase Invoice")
            purchase_invoice.company = doc.company
            purchase_invoice.supplier = supplier
            purchase_invoice.posting_date = doc.posting_date or today()
            purchase_invoice.currency = currency
            purchase_invoice.conversion_rate = exchange_rate

            # Set custom_original_purchase_invoice from purchase_receipts
            if original_purchase_invoice:
                purchase_invoice.custom_original_purchase_invoice = original_purchase_invoice

            # Get warehouse from first expense (if available) for set_warehouse
            set_warehouse = None
            for exp in expenses:
                if exp.get("warehouse"):
                    set_warehouse = exp["warehouse"]
                    break

            # Set update_stock and set_warehouse if warehouse is available
            if set_warehouse:
                purchase_invoice.update_stock = 1
                purchase_invoice.set_warehouse = set_warehouse

            # Add items - simple: just use custom_service_item and amount
            total_amount = 0
            for exp in expenses:
                # Add item to Purchase Invoice
                # Use: item_code (custom_service_item), rate (amount), description, warehouse (custom_supplier_warehouse)
                item_dict = {
                    "item_code": exp["service_item"],
                    "qty": 1.0,
                    "rate": exp["amount"],
                    "description": exp["description"] or ""
                }

                # Add warehouse from custom_supplier_warehouse if available
                if exp.get("warehouse"):
                    item_dict["warehouse"] = exp["warehouse"]

                purchase_invoice.append("items", item_dict)

                total_amount += exp["base_amount"]

            # Set missing values
            purchase_invoice.set_missing_values()

            # Save Purchase Invoice (as draft)
            purchase_invoice.insert(ignore_permissions=True)
            purchase_invoice.save(ignore_permissions=True)

            # Update custom_expense_purchase_invoice in all related tax rows
            for exp in expenses:
                frappe.db.set_value(
                    "Landed Cost Taxes and Charges",
                    exp["tax_row"].name,
                    "custom_expense_purchase_invoice",
                    purchase_invoice.name
                )

            frappe.db.commit()

            created_invoices.append({
                "supplier": supplier,
                "currency": currency,
                "invoice": purchase_invoice.name,
                "items_count": len(expenses),
                "total_amount": total_amount
            })

        except Exception as e:
            frappe.db.rollback()
            errors.append({
                "supplier": supplier,
                "error": str(e)
            })
            continue

    # Return result
    result = {
        "created_invoices": created_invoices,
        "errors": errors
    }

    if errors:
        error_msg = _("Some Purchase Invoices could not be created:\n")
        for err in errors:
            error_msg += _("Supplier {0}: {1}\n").format(err["supplier"], err["error"])
        frappe.msgprint(error_msg, alert=True, indicator="orange")
        frappe.log_error(f"[landed_cost_voucher.py] create_purchase_invoices_from_expenses")

    return result


def update_purchase_invoice_allocated_costs(doc, method):
    """
    Update custom_allocated_landed_cost table in Purchase Invoice
    when Landed Cost Voucher is submitted or cancelled.

    Mapping:
    - Allocated Landed Cost.cost = Landed Cost Taxes and Charges.custom_service_item
    - Allocated Landed Cost.total = Landed Cost Taxes and Charges.base_amount
    Includes all rows with custom_service_item (regardless of custom_expense_from_supplier)
    """
    if not doc.get("purchase_receipts"):
        return

    # Get all Purchase Invoices linked to this LCV
    purchase_invoices = set()

    for pr_row in doc.get("purchase_receipts"):
        if pr_row.receipt_document_type == "Purchase Invoice" and pr_row.receipt_document:
            purchase_invoices.add(pr_row.receipt_document)

    # Update each Purchase Invoice
    for purchase_invoice_name in purchase_invoices:
        try:
            # Delete only rows created by this LCV (not rows from Purchase Invoices or other LCVs)
            # This allows multiple LCVs and Purchase Invoices to coexist
            rows_to_delete = frappe.get_all(
                "Allocated Landed Cost",
                filters={
                    "parent": purchase_invoice_name,
                    "parenttype": "Purchase Invoice",
                    "parentfield": "custom_allocated_landed_cost",
                    "source_document_type": doc.doctype,
                    "source_document": doc.name
                },
                fields=["name"]
            )

            for row in rows_to_delete:
                frappe.db.delete("Allocated Landed Cost", row.name)

            # Get taxes rows from this LCV only (not all LCVs)
            # Get taxes rows where custom_service_item is set AND custom_expense_from_supplier != 1
            # Only include rows where custom_expense_from_supplier is not checked (0 or null)
            for tax_row in doc.get("taxes", []):
                # Skip rows where custom_expense_from_supplier == 1
                if cint(tax_row.get("custom_expense_from_supplier")) == 1:
                    continue

                # Only process rows with custom_service_item and custom_expense_from_supplier != 1
                if tax_row.get("custom_service_item"):
                    service_item = tax_row.custom_service_item
                    base_amount = flt(tax_row.get("base_amount") or 0)

                    if base_amount > 0:
                        # Add new row for this LCV
                        allocated_cost = frappe.new_doc("Allocated Landed Cost")
                        allocated_cost.parent = purchase_invoice_name
                        allocated_cost.parenttype = "Purchase Invoice"
                        allocated_cost.parentfield = "custom_allocated_landed_cost"
                        allocated_cost.cost = service_item
                        allocated_cost.total = base_amount
                        allocated_cost.vat = 0.0  # LCV doesn't have VAT calculation
                        allocated_cost.source_document_type = doc.doctype
                        allocated_cost.source_document = doc.name
                        allocated_cost.db_insert()

            frappe.db.commit()

        except Exception as e:
            frappe.db.rollback()
            frappe.log_error(f"[landed_cost_voucher.py] update_purchase_invoice_allocated_costs")


def update_original_purchase_invoice_allocated_costs(doc, method):
    """
    Update custom_allocated_landed_cost table in original Purchase Invoice
    when a Purchase Invoice with custom_original_purchase_invoice is submitted.

    Logic:
    - If Purchase Invoice has custom_original_purchase_invoice field set
    - Get all items from current Purchase Invoice (item_code, net_amount)
    - Update/add to custom_allocated_landed_cost in original Purchase Invoice
    - If item_code exists, add net_amount to existing total
    - If item_code doesn't exist, add new row
    """
    if not doc.get("custom_original_purchase_invoice"):
        return

    original_pi_name = doc.custom_original_purchase_invoice

    # Validate original Purchase Invoice exists
    if not frappe.db.exists("Purchase Invoice", original_pi_name):
        frappe.log_error(
            f"[landed_cost_voucher.py] update_original_purchase_invoice_allocated_costs: "
            f"Original Purchase Invoice {original_pi_name} not found"
        )
        return

    try:
        # Get original Purchase Invoice
        original_pi = frappe.get_doc("Purchase Invoice", original_pi_name)

        # Calculate itemised tax from taxes table
        itemised_tax = {}
        if doc.get("taxes"):
            itemised_tax = get_itemised_tax(doc.taxes)

        # Delete only rows created by this Purchase Invoice (not rows from LCVs or other Purchase Invoices)
        # This allows multiple Purchase Invoices and LCVs to coexist
        source_document_name = doc.name
        source_document_type = doc.doctype

        rows_to_delete = frappe.get_all(
            "Allocated Landed Cost",
            filters={
                "parent": original_pi_name,
                "parenttype": "Purchase Invoice",
                "parentfield": "custom_allocated_landed_cost",
                "source_document_type": source_document_type,
                "source_document": source_document_name
            },
            fields=["name"]
        )

        for row in rows_to_delete:
            frappe.db.delete("Allocated Landed Cost", row.name)

        # Get items from current Purchase Invoice
        # Each item from the current Purchase Invoice creates a separate row (no aggregation)
        # Note: itemised_tax uses key = item.item_code or item.item_name (same as set_item_wise_tax in ERPNext)
        for item in doc.get("items", []):
            if item.item_code and item.net_amount:
                item_code = item.item_code
                net_amount = flt(item.net_amount)

                # Calculate vat from itemised_tax
                # get_itemised_tax uses the same key logic as set_item_wise_tax: item.item_code or item.item_name
                vat_amount = 0.0

                # Use same key logic as set_item_wise_tax: key = item.item_code or item.item_name
                lookup_key = item.item_code or item.item_name
                if itemised_tax.get(lookup_key):
                    for tax_desc, tax_data in itemised_tax[lookup_key].items():
                        if isinstance(tax_data, dict) and tax_data.get("tax_amount"):
                            vat_amount += flt(tax_data.get("tax_amount", 0))

                # If still not found, calculate from item_tax_rate
                if vat_amount == 0.0 and item.item_tax_rate:
                    try:
                        item_tax_map = json.loads(item.item_tax_rate) if isinstance(
                            item.item_tax_rate, str) else item.item_tax_rate
                        if isinstance(item_tax_map, dict):
                            # Sum all tax rates and calculate tax amount
                            total_tax_rate = sum([flt(rate) for rate in item_tax_map.values()])
                            vat_amount = flt((net_amount * total_tax_rate) / 100.0)
                    except (json.JSONDecodeError, TypeError):
                        pass

                # Add new row for each item (no aggregation)
                allocated_cost = frappe.new_doc("Allocated Landed Cost")
                allocated_cost.parent = original_pi_name
                allocated_cost.parenttype = "Purchase Invoice"
                allocated_cost.parentfield = "custom_allocated_landed_cost"
                allocated_cost.cost = item_code
                allocated_cost.total = net_amount
                allocated_cost.vat = vat_amount
                allocated_cost.source_document_type = source_document_type
                allocated_cost.source_document = source_document_name
                allocated_cost.db_insert()

        frappe.db.commit()

    except Exception as e:
        frappe.db.rollback()
        frappe.log_error(f"[landed_cost_voucher.py] update_original_purchase_invoice_allocated_costs")


def update_original_purchase_invoice_allocated_costs_on_cancel(doc, method):
    """
    Reverse the update to custom_allocated_landed_cost table in original Purchase Invoice
    when a Purchase Invoice with custom_original_purchase_invoice is cancelled.

    Logic:
    - If Purchase Invoice has custom_original_purchase_invoice field set
    - Get all items from current Purchase Invoice (item_code, net_amount)
    - Subtract net_amount from existing total in original Purchase Invoice
    - If total becomes 0 or negative, delete the row
    """
    if not doc.get("custom_original_purchase_invoice"):
        return

    original_pi_name = doc.custom_original_purchase_invoice

    # Validate original Purchase Invoice exists
    if not frappe.db.exists("Purchase Invoice", original_pi_name):
        frappe.log_error(
            f"[landed_cost_voucher.py] update_original_purchase_invoice_allocated_costs_on_cancel: "
            f"Original Purchase Invoice {original_pi_name} not found"
        )
        return

    try:
        # Get original Purchase Invoice
        original_pi = frappe.get_doc("Purchase Invoice", original_pi_name)

        # Delete all rows that were created from this Purchase Invoice
        # Each item from the cancelled Purchase Invoice has its own row identified by source_document
        source_document_name = doc.name
        source_document_type = doc.doctype

        # Find and delete all rows created from this source document
        rows_to_delete = frappe.get_all(
            "Allocated Landed Cost",
            filters={
                "parent": original_pi_name,
                "parenttype": "Purchase Invoice",
                "parentfield": "custom_allocated_landed_cost",
                "source_document_type": source_document_type,
                "source_document": source_document_name
            },
            fields=["name"]
        )

        for row in rows_to_delete:
            frappe.db.delete("Allocated Landed Cost", row.name)

        frappe.db.commit()

    except Exception as e:
        frappe.db.rollback()
        frappe.log_error(f"[landed_cost_voucher.py] update_original_purchase_invoice_allocated_costs_on_cancel")


@frappe.whitelist()
def fix_old_allocated_costs_for_invoice(purchase_invoice_name):
    """
    Fix old Allocated Landed Cost rows for a specific Purchase Invoice.
    Updates rows that don't have source_document_type and source_document.

    Usage: bench --site all execute aljamil_customizations.landed_cost_voucher.fix_old_allocated_costs_for_invoice --kwargs '{"purchase_invoice_name": "ACC-PINV-2026-00037"}'
    """
    if not frappe.db.exists("Purchase Invoice", purchase_invoice_name):
        frappe.throw(f"Purchase Invoice {purchase_invoice_name} not found")

    pi = frappe.get_doc("Purchase Invoice", purchase_invoice_name)
    original_pi_name = pi.get("custom_original_purchase_invoice")

    if not original_pi_name:
        frappe.throw(f"Purchase Invoice {purchase_invoice_name} does not have custom_original_purchase_invoice")

    # Get items from this Purchase Invoice
    items_list = []
    for item in pi.get("items", []):
        if item.item_code:
            items_list.append(item.item_code)

    if not items_list:
        frappe.msgprint(f"No items found in {purchase_invoice_name}.")
        return

    # Find rows in original PI that match these items but don't have source_document
    rows_to_fix = frappe.get_all(
        "Allocated Landed Cost",
        filters={
            "parent": original_pi_name,
            "parenttype": "Purchase Invoice",
            "parentfield": "custom_allocated_landed_cost",
            "source_document_type": ["is", "not set"],
            "source_document": ["is", "not set"],
            "cost": ["in", items_list]
        },
        fields=["name", "cost", "total", "vat"]
    )

    if not rows_to_fix:
        frappe.msgprint(f"No rows to fix for {purchase_invoice_name}.")
        return

    # Update rows
    updated_count = 0
    for row in rows_to_fix:
        frappe.db.set_value(
            "Allocated Landed Cost",
            row.name,
            {
                "source_document_type": "Purchase Invoice",
                "source_document": purchase_invoice_name
            }
        )
        updated_count += 1

    frappe.db.commit()
    frappe.msgprint(f"Fixed {updated_count} rows for {purchase_invoice_name}.")
    return updated_count
