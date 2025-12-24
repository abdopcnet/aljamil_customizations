frappe.ui.form.on('Sales Invoice', {
	refresh(frm) {
		console.log(
			'KH Quick Pay: refresh on Sales Invoice',
			frm.doc.name,
			'docstatus:',
			frm.doc.docstatus,
		);

		// Only work after Submit
		if (frm.doc.docstatus !== 1) return;

		frm.add_custom_button(__('💰 تسجيل دفع (Popup)'), function () {
			open_quick_payment_dialog_for_so(frm);
		}).addClass('btn-danger');
	},
});

function open_quick_payment_dialog_for_so(frm) {
	const d = new frappe.ui.Dialog({
		title: __('تسجيل دفع لفاتورة المبيعات') + frm.doc.name,
		fields: [
			{
				fieldname: 'posting_date',
				fieldtype: 'Date',
				label: __('Posting Date'),
				reqd: 1,
				default: frappe.datetime.get_today(),
			},
			{
				fieldname: 'mode_of_payment',
				fieldtype: 'Link',
				label: __('Mode of Payment'),
				options: 'Mode of Payment',
				reqd: 1,
			},
			{
				fieldname: 'paid_amount',
				fieldtype: 'Currency',
				label: __('Paid Amount'),
				reqd: 1,
				default: frm.doc.outstanding_amount || 0,
			},
			{
				fieldname: 'reference_no',
				fieldtype: 'Data',
				label: __('Reference No'),
			},
			{
				fieldname: 'reference_date',
				fieldtype: 'Date',
				label: __('Reference Date'),
				default: frappe.datetime.get_today(),
			},
		],
		primary_action_label: __('إنشاء سند دفع'),
		primary_action: async function (values) {
			if (!values.paid_amount || flt(values.paid_amount) <= 0) {
				frappe.msgprint(__('الرجاء إدخال مبلغ دفع صحيح.'));
				return;
			}

			try {
				const pe_res = await frappe.call({
					method: 'erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry',
					args: {
						dt: frm.doc.doctype,
						dn: frm.doc.name,
					},
				});

				if (!pe_res.message) {
					frappe.msgprint(__('تعذر إنشاء سند الدفع.'));
					return;
				}

				let pe = pe_res.message;
				pe.mode_of_payment = values.mode_of_payment;

				if (frm.doc.branch) {
					pe.branch = frm.doc.branch;
				}

				pe.posting_date = values.posting_date;
				pe.reference_no = values.reference_no;
				pe.reference_date = values.reference_date;

				// 4. Calculate payment amount and validate against outstanding
				let pay_amount = flt(values.paid_amount);
				if (pe.references && pe.references.length) {
					let ref = pe.references[0];
					let outstanding = flt(ref.outstanding_amount) || flt(ref.total_amount) || 0;
					if (outstanding && pay_amount > outstanding) {
						pay_amount = outstanding;
					}
					ref.allocated_amount = pay_amount;
				}

				// 5. Set payment amounts
				pe.paid_amount = pay_amount;
				pe.received_amount = pay_amount;

				// 6. Get default account from Mode of Payment for the company
				await new Promise((resolve, reject) => {
					frappe.call({
						method: 'frappe.client.get_value',
						args: {
							doctype: 'Mode of Payment Account',
							filters: {
								parent: values.mode_of_payment,
								company: frm.doc.company,
							},
							fieldname: 'default_account',
						},
						callback: function (r) {
							if (r.message && r.message.default_account) {
								let payment_account_field =
									pe.payment_type == 'Receive' ? 'paid_to' : 'paid_from';
								pe[payment_account_field] = r.message.default_account;
								resolve();
							} else {
								reject(new Error('لم يتم العثور على حساب افتراضي لطريقة الدفع'));
							}
						},
					});
				});

				// 7. Insert the payment entry document
				const insert_res = await frappe.call({
					method: 'frappe.client.insert',
					args: { doc: pe },
				});

				if (!insert_res.message) {
					frappe.msgprint(__('حدث خطأ أثناء إنشاء سند الدفع.'));
					return;
				}

				// 8. Submit the payment entry
				const submit_res = await frappe.call({
					method: 'frappe.client.submit',
					args: { doc: insert_res.message },
				});

				if (submit_res.message) {
					frappe.msgprint(
						__('تم إنشاء وتقديم سند الدفع: {0}', [submit_res.message.name]),
					);
					frm.reload_doc();
					d.hide();
				} else {
					frappe.msgprint(__('حدث خطأ أثناء تقديم سند الدفع.'));
				}
			} catch (e) {
				frappe.msgprint(__('حدث خطأ أثناء إنشاء سند الدفع.'));
			}
		},
	});

	d.show();
}
