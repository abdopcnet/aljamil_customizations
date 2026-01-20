import frappe
from frappe import _
from frappe.utils import flt
import json
from erpnext.controllers.taxes_and_totals import get_itemised_tax


def update_original_purchase_invoice_allocated_costs(doc, method):
    """
    Update custom_allocated_landed_cost table in original Purchase Invoice
    when a Purchase Invoice with custom_original_purchase_invoice is submitted.

    Logic:
    - If Purchase Invoice has custom_original_purchase_invoice field set
    - Get all items from current Purchase Invoice (item_code, net_amount)
    - Each item creates a separate row (no aggregation)
    - Calculate VAT from itemised_tax or item_tax_rate
    """
    if not doc.get("custom_original_purchase_invoice"):
        return

    original_pi_name = doc.custom_original_purchase_invoice

    # Validate original Purchase Invoice exists
    if not frappe.db.exists("Purchase Invoice", original_pi_name):
        frappe.log_error(f"[purchase_invoice.py] update_original_purchase_invoice_allocated_costs")
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

        # Update totals in original Purchase Invoice
        update_allocated_costs_totals(original_pi_name)

    except Exception as e:
        frappe.log_error(f"[purchase_invoice.py] update_original_purchase_invoice_allocated_costs")


def update_original_purchase_invoice_allocated_costs_on_cancel(doc, method):
    """
    Reverse the update to custom_allocated_landed_cost table in original Purchase Invoice
    when a Purchase Invoice with custom_original_purchase_invoice is cancelled.

    Logic:
    - If Purchase Invoice has custom_original_purchase_invoice field set
    - Delete all rows that were created from this Purchase Invoice
    """
    if not doc.get("custom_original_purchase_invoice"):
        return

    original_pi_name = doc.custom_original_purchase_invoice

    # Validate original Purchase Invoice exists
    if not frappe.db.exists("Purchase Invoice", original_pi_name):
        frappe.log_error(f"[purchase_invoice.py] update_original_purchase_invoice_allocated_costs_on_cancel")
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

        # Update totals in original Purchase Invoice
        update_allocated_costs_totals(original_pi_name)

    except Exception as e:
        frappe.log_error(f"[purchase_invoice.py] update_original_purchase_invoice_allocated_costs_on_cancel")


def update_allocated_costs_totals(doc, method=None):
    """
    Calculate and update custom_total_cost and custom_vat_on_costs
    from custom_allocated_landed_cost child table.

    This function can be called:
    - As a hook (validate, before_save, etc.)
    - Directly from other functions
    """
    # Handle both doc (from hook) and doc_name (from direct call)
    if method:
        # Called as hook
        pi_doc = doc
        pi_name = doc.name
    else:
        # Called directly with doc_name
        pi_name = doc
        pi_doc = frappe.get_doc("Purchase Invoice", pi_name)

    if not pi_doc.get("custom_allocated_landed_cost"):
        # No allocated costs, set totals to 0
        if method:
            pi_doc.custom_total_cost = 0.0
            pi_doc.custom_vat_on_costs = 0.0
        else:
            frappe.db.set_value("Purchase Invoice", pi_name, {
                "custom_total_cost": 0.0,
                "custom_vat_on_costs": 0.0
            })
        return

    # Calculate totals from child table
    total_cost = 0.0
    total_vat = 0.0

    for row in pi_doc.get("custom_allocated_landed_cost", []):
        total_cost += flt(row.total or 0)
        total_vat += flt(row.vat or 0)

    # Update fields
    if method:
        # Called as hook - update doc directly
        pi_doc.custom_total_cost = total_cost
        pi_doc.custom_vat_on_costs = total_vat
    else:
        # Called directly - update via db
        frappe.db.set_value("Purchase Invoice", pi_name, {
            "custom_total_cost": total_cost,
            "custom_vat_on_costs": total_vat
        })


@frappe.whitelist()
def refresh_allocated_costs_totals(purchase_invoice_name):
    """
    Refresh and update custom_total_cost and custom_vat_on_costs
    from custom_allocated_landed_cost child table.
    Called from JavaScript on refresh event.
    Returns the calculated totals.
    """
    if not purchase_invoice_name:
        return {"total_cost": 0.0, "total_vat": 0.0}

    try:
        # Get child table rows directly from database
        allocated_costs = frappe.get_all(
            "Allocated Landed Cost",
            filters={
                "parent": purchase_invoice_name,
                "parenttype": "Purchase Invoice",
                "parentfield": "custom_allocated_landed_cost"
            },
            fields=["total", "vat"]
        )

        # Calculate totals from child table
        total_cost = 0.0
        total_vat = 0.0

        for row in allocated_costs:
            total_cost += flt(row.get("total") or 0)
            total_vat += flt(row.get("vat") or 0)

        # Get current values from database
        current_values = frappe.db.get_value(
            "Purchase Invoice",
            purchase_invoice_name,
            ["custom_total_cost", "custom_vat_on_costs"],
            as_dict=True
        )
        current_total_cost = flt(current_values.get("custom_total_cost") or 0)
        current_total_vat = flt(current_values.get("custom_vat_on_costs") or 0)

        # Update only if there's a difference
        if abs(total_cost - current_total_cost) > 0.01 or abs(total_vat - current_total_vat) > 0.01:
            frappe.db.set_value("Purchase Invoice", purchase_invoice_name, {
                "custom_total_cost": total_cost,
                "custom_vat_on_costs": total_vat
            })
            frappe.db.commit()

        return {
            "total_cost": total_cost,
            "total_vat": total_vat,
            "updated": abs(total_cost - current_total_cost) > 0.01 or abs(total_vat - current_total_vat) > 0.01
        }

    except Exception as e:
        frappe.log_error(f"[purchase_invoice.py] refresh_allocated_costs_totals")
        return {"total_cost": 0.0, "total_vat": 0.0}
