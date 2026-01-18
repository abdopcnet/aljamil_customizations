import frappe


@frappe.whitelist()
def get_po_items(params=None):
    """
    Server helper to retrieve Purchase Order Item rows related to a Sales Order
    or by item codes within Purchase Orders of same company+warehouse.

    Args (client passes a dict as JSON string or object):
        params = {
            'sales_order': 'SAL-ORD-2026-00001',
            # OR
            'company': 'My Company',
            'set_warehouse': 'Rabwa - AO',
            'item_codes': ['ITEM-1', 'ITEM-2']
        }

    Only users with purchase-related roles can access this endpoint; otherwise
    an empty list is returned to avoid permission errors on the client.
    """
    if isinstance(params, str):
        try:
            params = frappe.parse_json(params)
        except Exception:
            params = None

    params = params or {}

    # Only allow for users with purchase privileges
    allowed_roles = ('Purchase User', 'Purchase Manager', 'System Manager')
    if not any(role in (frappe.get_roles() or []) for role in allowed_roles):
        return []

    sales_order = params.get('sales_order')
    company = params.get('company')
    set_warehouse = params.get('set_warehouse')
    item_codes = params.get('item_codes') or []

    try:
        if sales_order:
            return frappe.get_all(
                'Purchase Order Item',
                filters={'sales_order': sales_order},
                fields=['parent', 'sales_order_item'],
            )

        if company and set_warehouse and item_codes:
            # find candidate POs in company+warehouse
            po_names = [r.name for r in frappe.get_all('Purchase Order', filters={'company': company, 'set_warehouse': set_warehouse}, fields=['name'])]
            if not po_names:
                return []
            return frappe.get_all(
                'Purchase Order Item',
                filters=[['parent', 'in', po_names], ['item_code', 'in', item_codes]],
                fields=['parent', 'item_code'],
            )

    except Exception:
        # If anything goes wrong, return empty list rather than raising
        return []

    return []
