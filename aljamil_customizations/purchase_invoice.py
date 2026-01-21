import frappe
from frappe import _
from frappe.utils import flt
import json
from erpnext.controllers.taxes_and_totals import get_itemised_tax


def update_original_purchase_invoice_allocated_costs_on_submit_cost_purchase_invoice(doc, method):
    """
    Update custom_allocated_landed_cost table in original Purchase Invoice
    when a Purchase Invoice with custom_original_purchase_invoice is submitted.

    Logic:
    - From cost invoice (Purchase Invoice with custom_original_purchase_invoice)
    - tabPurchase Invoice Item.item_code -> Allocated Landed Cost.custom_service_item
    - tabPurchase Invoice Item.base_net_amount -> Allocated Landed Cost.item_base_amount (base currency)
    - tabPurchase Invoice Item.item_tax_rate -> Allocated Landed Cost.item_base_tax_amount (calculated from base_net_amount at item level, base currency)
    - tabPurchase Invoice.doctype -> Allocated Landed Cost.source_document_type
    - tabPurchase Invoice.name -> Allocated Landed Cost.source_document
    """
    if not doc.get("custom_original_purchase_invoice"):
        return

    original_pi_name = doc.custom_original_purchase_invoice

    # Validate original Purchase Invoice exists
    if not frappe.db.exists("Purchase Invoice", original_pi_name):
        frappe.log_error(f"[purchase_invoice.py] update_original_purchase_invoice_allocated_costs_on_submit_cost_purchase_invoice")
        return

    try:
        source_document_name = doc.name
        source_document_type = doc.doctype

        # Delete only rows created by this Purchase Invoice
        frappe.db.sql("""
            DELETE FROM `tabAllocated Landed Cost`
            WHERE parent = %s
            AND parenttype = 'Purchase Invoice'
            AND parentfield = 'custom_allocated_landed_cost'
            AND source_document_type = %s
            AND source_document = %s
        """, (original_pi_name, source_document_type, source_document_name))

        # Get items from current Purchase Invoice using SQL
        # Use base_net_amount directly from database (base currency, item level)
        items_data = frappe.db.sql("""
            SELECT item_code, base_net_amount, item_tax_rate
            FROM `tabPurchase Invoice Item`
            WHERE parent = %s
            AND item_code IS NOT NULL
            AND item_code != ''
            AND base_net_amount > 0
        """, (doc.name,), as_dict=True)

        # Calculate itemised tax from taxes table (for VAT)
        itemised_tax = {}
        if doc.get("taxes"):
            itemised_tax = get_itemised_tax(doc.taxes)

        # Add new row for each item
        for item in items_data:
            item_code = item.item_code
            base_net_amount = flt(item.base_net_amount)

            # Calculate item_base_tax_amount from item_tax_rate using base_net_amount (item level tax calculation)
            item_base_tax_amount = 0.0
            if item.item_tax_rate:
                try:
                    item_tax_map = json.loads(item.item_tax_rate) if isinstance(
                        item.item_tax_rate, str) else item.item_tax_rate
                    if isinstance(item_tax_map, dict):
                        total_tax_rate = sum([flt(rate) for rate in item_tax_map.values()])
                        item_base_tax_amount = flt((base_net_amount * total_tax_rate) / 100.0)
                except (json.JSONDecodeError, TypeError):
                    pass

            # If still not found, try to get from itemised_tax (base currency)
            if item_base_tax_amount == 0.0 and itemised_tax.get(item_code):
                for tax_desc, tax_data in itemised_tax[item_code].items():
                    if isinstance(tax_data, dict) and tax_data.get("tax_amount"):
                        base_tax = tax_data.get("base_tax_amount") or tax_data.get("tax_amount", 0)
                        item_base_tax_amount += flt(base_tax, 0)

            # Add new row
            allocated_cost = frappe.new_doc("Allocated Landed Cost")
            allocated_cost.parent = original_pi_name
            allocated_cost.parenttype = "Purchase Invoice"
            allocated_cost.parentfield = "custom_allocated_landed_cost"
            allocated_cost.custom_service_item = item_code
            allocated_cost.item_base_amount = base_net_amount
            allocated_cost.item_base_tax_amount = item_base_tax_amount
            allocated_cost.source_document_type = source_document_type
            allocated_cost.source_document = source_document_name
            allocated_cost.db_insert()

        frappe.db.commit()

        # Update totals in original Purchase Invoice
        update_allocated_costs_totals(original_pi_name)

    except Exception as e:
        frappe.log_error(f"[purchase_invoice.py] update_original_purchase_invoice_allocated_costs_on_submit_cost_purchase_invoice")


def update_original_purchase_invoice_allocated_costs_on_cancel_cost_purchase_invoice(doc, method):
    """
    Reverse the update to custom_allocated_landed_cost table in original Purchase Invoice
    when a Purchase Invoice with custom_original_purchase_invoice is cancelled.

    Simple logic:
    - Delete all rows that were created from this Purchase Invoice
    - Based on: tabPurchase Invoice Item.base_net_amount
    """
    if not doc.get("custom_original_purchase_invoice"):
        return

    original_pi_name = doc.custom_original_purchase_invoice

    # Validate original Purchase Invoice exists
    if not frappe.db.exists("Purchase Invoice", original_pi_name):
        frappe.log_error(f"[purchase_invoice.py] update_original_purchase_invoice_allocated_costs_on_cancel_cost_purchase_invoice")
        return

    try:
        source_document_name = doc.name
        source_document_type = doc.doctype

        # Delete all rows created from this Purchase Invoice using SQL
        frappe.db.sql("""
            DELETE FROM `tabAllocated Landed Cost`
            WHERE parent = %s
            AND parenttype = 'Purchase Invoice'
            AND parentfield = 'custom_allocated_landed_cost'
            AND source_document_type = %s
            AND source_document = %s
        """, (original_pi_name, source_document_type, source_document_name))

        frappe.db.commit()

        # Update totals in original Purchase Invoice
        update_allocated_costs_totals(original_pi_name)

    except Exception as e:
        frappe.log_error(f"[purchase_invoice.py] update_original_purchase_invoice_allocated_costs_on_cancel_cost_purchase_invoice")


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

    # Calculate totals from child table using new fields
    total_cost = 0.0
    total_vat = 0.0

    for row in pi_doc.get("custom_allocated_landed_cost", []):
        total_cost += flt(row.item_base_amount or 0)
        total_vat += flt(row.item_base_tax_amount or 0)

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
def recalculate_allocated_costs_from_pi(source_purchase_invoice_name):
    """
    Recalculate Allocated Landed Cost rows in original Purchase Invoice
    from a source Purchase Invoice that has custom_original_purchase_invoice.
    
    Uses base_net_amount directly from database (base currency, item level).
    
    Usage: bench --site all execute aljamil_customizations.purchase_invoice.recalculate_allocated_costs_from_pi --kwargs '{"source_purchase_invoice_name": "ACC-PINV-2026-00052"}'
    """
    if not frappe.db.exists("Purchase Invoice", source_purchase_invoice_name):
        frappe.log_error(f"[purchase_invoice.py] recalculate_allocated_costs_from_pi")
        return False
    
    original_pi_name = frappe.db.get_value("Purchase Invoice", source_purchase_invoice_name, "custom_original_purchase_invoice")
    
    if not original_pi_name:
        frappe.log_error(f"[purchase_invoice.py] recalculate_allocated_costs_from_pi")
        return False
    
    if not frappe.db.exists("Purchase Invoice", original_pi_name):
        frappe.log_error(f"[purchase_invoice.py] recalculate_allocated_costs_from_pi")
        return False
    
    try:
        source_pi = frappe.get_doc("Purchase Invoice", source_purchase_invoice_name)
        source_document_name = source_pi.name
        source_document_type = source_pi.doctype
        
        # Delete only rows created by this Purchase Invoice
        frappe.db.sql("""
            DELETE FROM `tabAllocated Landed Cost`
            WHERE parent = %s
            AND parenttype = 'Purchase Invoice'
            AND parentfield = 'custom_allocated_landed_cost'
            AND source_document_type = %s
            AND source_document = %s
        """, (original_pi_name, source_document_type, source_document_name))
        
        # Get items from source Purchase Invoice using SQL
        # Use base_net_amount directly from database (base currency, item level)
        items_data = frappe.db.sql("""
            SELECT item_code, base_net_amount, item_tax_rate
            FROM `tabPurchase Invoice Item`
            WHERE parent = %s
            AND item_code IS NOT NULL
            AND item_code != ''
            AND base_net_amount > 0
        """, (source_purchase_invoice_name,), as_dict=True)
        
        # Calculate itemised tax from taxes table (for VAT)
        itemised_tax = {}
        if source_pi.get("taxes"):
            itemised_tax = get_itemised_tax(source_pi.taxes)
        
        # Add new row for each item
        for item in items_data:
            item_code = item.item_code
            base_net_amount = flt(item.base_net_amount)
            
            # Calculate item_base_tax_amount from item_tax_rate using base_net_amount (item level tax calculation, base currency)
            item_base_tax_amount = 0.0
            if item.item_tax_rate:
                try:
                    item_tax_map = json.loads(item.item_tax_rate) if isinstance(
                        item.item_tax_rate, str) else item.item_tax_rate
                    if isinstance(item_tax_map, dict):
                        total_tax_rate = sum([flt(rate) for rate in item_tax_map.values()])
                        item_base_tax_amount = flt((base_net_amount * total_tax_rate) / 100.0)
                except (json.JSONDecodeError, TypeError):
                    pass
            
            # If still not found, try to get from itemised_tax (base currency)
            if item_base_tax_amount == 0.0 and itemised_tax.get(item_code):
                for tax_desc, tax_data in itemised_tax[item_code].items():
                    if isinstance(tax_data, dict) and tax_data.get("tax_amount"):
                        base_tax = tax_data.get("base_tax_amount") or tax_data.get("tax_amount", 0)
                        item_base_tax_amount += flt(base_tax, 0)
            
            # Add new row
            allocated_cost = frappe.new_doc("Allocated Landed Cost")
            allocated_cost.parent = original_pi_name
            allocated_cost.parenttype = "Purchase Invoice"
            allocated_cost.parentfield = "custom_allocated_landed_cost"
            allocated_cost.custom_service_item = item_code
            allocated_cost.item_base_amount = base_net_amount
            allocated_cost.item_base_tax_amount = item_base_tax_amount
            allocated_cost.source_document_type = source_document_type
            allocated_cost.source_document = source_document_name
            allocated_cost.db_insert()
        
        frappe.db.commit()
        
        # Update totals in original Purchase Invoice
        update_allocated_costs_totals(original_pi_name)
        
        return True
        
    except Exception as e:
        frappe.log_error(f"[purchase_invoice.py] recalculate_allocated_costs_from_pi")
        return False


@frappe.whitelist()
def refresh_allocated_costs_on_open(purchase_invoice_name):
    """
    Refresh Allocated Landed Cost rows when Purchase Invoice is opened.
    Recalculates from:
    - Landed Cost Vouchers (tabLanded Cost Taxes and Charges.base_amount -> item_base_amount, base currency)
    - Cost Purchase Invoices (tabPurchase Invoice Item.base_net_amount -> item_base_amount, base currency, item level)
    
    Called from JavaScript on onload event.
    """
    if not purchase_invoice_name:
        return {"updated": False}

    try:
        # Recalculate from LCVs
        lcv_list = frappe.db.sql("""
            SELECT DISTINCT parent as lcv_name
            FROM `tabLanded Cost Purchase Receipt`
            WHERE receipt_document = %s
            AND receipt_document_type = 'Purchase Invoice'
        """, (purchase_invoice_name,), as_dict=True)
        
        for lcv_row in lcv_list:
            try:
                # Import here to avoid circular import
                from aljamil_customizations.landed_cost_voucher import (
                    update_original_purchase_invoice_allocated_costs_on_submit_landed_cost_voucher
                )
                lcv_doc = frappe.get_doc("Landed Cost Voucher", lcv_row.lcv_name)
                if lcv_doc.docstatus == 1:
                    update_original_purchase_invoice_allocated_costs_on_submit_landed_cost_voucher(lcv_doc, None)
            except:
                pass
        
        # Recalculate from cost Purchase Invoices
        cost_invoices = frappe.db.sql("""
            SELECT name
            FROM `tabPurchase Invoice`
            WHERE custom_original_purchase_invoice = %s
            AND docstatus = 1
        """, (purchase_invoice_name,), as_dict=True)
        
        for cost_inv in cost_invoices:
            try:
                cost_pi = frappe.get_doc("Purchase Invoice", cost_inv.name)
                update_original_purchase_invoice_allocated_costs_on_submit_cost_purchase_invoice(cost_pi, None)
            except:
                pass
        
        # Update totals
        update_allocated_costs_totals(purchase_invoice_name)
        
        return {"updated": True}

    except Exception as e:
        frappe.log_error(f"[purchase_invoice.py] refresh_allocated_costs_on_open")
        return {"updated": False}


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
        # Get child table rows directly from database using new fields
        allocated_costs = frappe.get_all(
            "Allocated Landed Cost",
            filters={
                "parent": purchase_invoice_name,
                "parenttype": "Purchase Invoice",
                "parentfield": "custom_allocated_landed_cost"
            },
            fields=["item_base_amount", "item_base_tax_amount"]
        )

        # Calculate totals from child table
        total_cost = 0.0
        total_vat = 0.0

        for row in allocated_costs:
            total_cost += flt(row.get("item_base_amount") or 0)
            total_vat += flt(row.get("item_base_tax_amount") or 0)

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
