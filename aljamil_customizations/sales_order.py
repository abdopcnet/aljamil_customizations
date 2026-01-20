# Copyright (c) 2025, Aljamil Customizations
# License: MIT

import frappe
from frappe import _


def send_discount_approval_notifications(doc, method=None):
    """
    Send approval notifications to Sales Managers for items with custom_discount2
    that require approval.

    This function is called before_save on Sales Order.
    """
    # Get all users with Sales Manager role
    valid_users = frappe.db.get_all(
        "Has Role",
        filters={"role": "Sales Manager"},
        fields=["parent"],
    )

    if not valid_users:
        return

    # Process each item that needs approval
    for item in doc.items:
        if item.custom_discount2 > 0 and not item.custom_discount2_approved:
            _send_notifications_for_item(doc, item, valid_users)


def _send_notifications_for_item(doc, item, valid_users):
    """Send notifications to eligible Sales Managers for a specific item."""
    for user_record in valid_users:
        user = user_record.parent

        # Check if user is enabled
        if not frappe.db.exists("User", {"name": user, "enabled": 1}):
            continue

        # Check if user has permission on the branch
        has_branch_permission = frappe.db.exists(
            "User Permission",
            {
                "user": user,
                "allow": "Branch",
                "for_value": doc.branch,
            },
        )

        if has_branch_permission:
            subject = (
                f"🔔 خصم {frappe.utils.fmt_money(item.custom_discount2)} ريال "
                f"على الصنف {item.item_code} "
                f"(كود الخصم: {item.custom_discount_code or 'غير متوفر'}) يتطلب موافقة"
            )

            # Check if notification already exists
            existing_log = frappe.db.exists(
                "Notification Log",
                {
                    "document_type": doc.doctype,
                    "document_name": doc.name,
                    "for_user": user,
                    "subject": subject,
                    "read": 0,
                },
            )

            if not existing_log:
                try:
                    frappe.get_doc(
                        {
                            "doctype": "Notification Log",
                            "document_type": doc.doctype,
                            "document_name": doc.name,
                            "subject": subject,
                            "type": "Alert",
                            "for_user": user,
                        }
                    ).insert(ignore_permissions=True)
                except Exception as e:
                    frappe.log_error(f"[sales_order.py] send_discount_approval_notifications")
