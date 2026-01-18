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
		title: __('تسجيل دفع لفاتورة المبيعات') + (frm.doc.name ? ' ' + frm.doc.name : ''),
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
				default: frm.doc.custom_outstanding_amount || 0,
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
			// 1. Validate payment amount
			if (!values.paid_amount || flt(values.paid_amount) <= 0) {
				frappe.msgprint(__('الرجاء إدخال مبلغ دفع صحيح.'));
				return;
			}

			try {
				// 2. Get payment entry template from ERPNext
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

				// 3. Prepare payment entry with user values
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
						method: 'erpnext.accounts.doctype.sales_invoice.sales_invoice.get_bank_cash_account',
						args: {
							mode_of_payment: values.mode_of_payment,
							company: frm.doc.company,
						},
						callback: function (r) {
							if (r.message && r.message.account) {
								let payment_account_field =
									pe.payment_type == 'Receive' ? 'paid_to' : 'paid_from';
								pe[payment_account_field] = r.message.account;
								resolve();
							} else {
								reject(
									new Error(
										'لم يتم العثور على حساب افتراضي لطريقة الدفع لهذه الشركة',
									),
								);
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

// لو عندك جدول كشوفات في فاتورة المبيعات نفسها (Sales Invoice) حط اسمه هنا
// عادةً بيكون نفس الاسم اللي في Sales Order لو الحقول منقولة
const INVOICE_EXAMS_CHILD_FIELD = 'custom_size';

// ماب من أسماء الحقول بين الفورم و الـ child doctype
const EYE_EXAM_FIELDNAMES = {
	date: 'date',
	sph_r: 'sph_r',
	cyl_r: 'cyl_r',
	axis_r: 'axis_r',
	add_r: 'add_r',
	pd_r: 'pd_r',

	sph_l: 'sph_l',
	cyl_l: 'cyl_l',
	axis_l: 'axis_l',
	add_l: 'add_l',
	pd_l: 'pd_l',
};

// ========================= زرار الكشف الطبي في فاتورة المبيعات =========================

frappe.ui.form.on('Sales Invoice', {
	refresh(frm) {
		// نمسح الزرار القديم لو موجود
		if (frm.page.eye_btn && !frm.page.eye_btn.is_destroyed) {
			frm.page.eye_btn.remove();
		}

		// نضيف الزرار كل مرة
		frm.page.eye_btn = frm.page
			.add_inner_button(__('الكشف الطبي (Eye Prescription)'), function () {
				if (!frm.doc.customer) {
					frappe.msgprint({
						title: __('تنبيه'),
						message: __('من فضلك اختر العميل أولاً قبل فتح كشف النظر.'),
						indicator: 'orange',
					});
					return;
				}
				open_eye_dialog(frm);
			})
			.addClass('btn-primary');
	},
});

// ========================= الدialog الرئيسي =========================

function open_eye_dialog(frm) {
	// Ensure metas are loaded
	frappe.model.with_doctype('Customer', () => {
		frappe.model.with_doctype('Eye Prescription', () => {
			_open_dialog_logic(frm);
		});
	});
}

function _open_dialog_logic(frm) {
	// نبني الدialog
	const d = new frappe.ui.Dialog({
		title: __('الكشف الطبي (Eye Prescription) - فاتورة المبيعات'),
		size: 'large',
		fields: [
			{ fieldtype: 'Section Break', label: 'كشف جديد 🔍' },

			{
				fieldname: 'exam_date',
				fieldtype: 'Date',
				label: __('تاريخ الكشف'),
				reqd: 1,
				default: frm.doc.posting_date || frappe.datetime.get_today(), // Use posting_date for Invoice
			},

			// Right / Left منظمين: كل عين فى كولوم لوحدها
			{ fieldtype: 'Column Break' },

			{ fieldname: 'sph_r', label: 'SPH-R', fieldtype: 'Data' },
			{ fieldname: 'cyl_r', label: 'CYL-R', fieldtype: 'Data' },
			{ fieldname: 'axis_r', label: 'Axis-R', fieldtype: 'Data' },
			{ fieldname: 'add_r', label: 'ADD-R', fieldtype: 'Data' },
			{ fieldname: 'pd_r', label: 'PD-R', fieldtype: 'Data' },

			{ fieldtype: 'Column Break' },

			{ fieldname: 'sph_l', label: 'SPH-L', fieldtype: 'Data' },
			{ fieldname: 'cyl_l', label: 'CYL-L', fieldtype: 'Data' },
			{ fieldname: 'axis_l', label: 'Axis-L', fieldtype: 'Data' },
			{ fieldname: 'add_l', label: 'ADD-L', fieldtype: 'Data' },
			{ fieldname: 'pd_l', label: 'PD-L', fieldtype: 'Data' },

			{ fieldtype: 'Section Break', label: '📜 الكشوفات المسجلة في هذه الفاتورة' },
			{
				fieldname: 'invoice_exams_html',
				fieldtype: 'HTML',
			},

			{ fieldtype: 'Section Break', label: '📂 الكشوفات السابقة لهذا العميل' },
			{
				fieldname: 'previous_exams_html',
				fieldtype: 'HTML',
			},

			{ fieldtype: 'Section Break' },
		],
		primary_action_label: __('حفظ الكشف في الفاتورة'),
		primary_action: function () {
			save_new_exam(frm, d);
		},
	});

	// نرسم جدول "الكشوفات المسجلة في هذه الفاتورة"
	render_invoice_exam_table(frm, d);

	// Discover Table Name
	const cust_meta = frappe.get_meta('Customer');
	if (cust_meta) {
		const field = cust_meta.fields.find(
			(df) => df.fieldtype === 'Table' && df.options === 'Eye Prescription',
		);
		if (field) {
			d.custom_eye_table_field = field.fieldname;
		}
	}

	// Discover Column Names
	const child_meta = frappe.get_meta('Eye Prescription');
	if (child_meta) {
		const label_map = {
			'sph-r': 'sph_r',
			'cyl-r': 'cyl_r',
			'axis-r': 'axis_r',
			'add-r': 'add_r',
			'pd-r': 'pd_r',
			'sph-l': 'sph_l',
			'cyl-l': 'cyl_l',
			'axis-l': 'axis_l',
			'add-l': 'add_l',
			'pd-l': 'pd_l',
			date: 'date',
		};
		const new_map = {};
		child_meta.fields.forEach((df) => {
			const label = (df.label || '').toLowerCase();
			for (const k in label_map) {
				if (
					label.includes(k) ||
					(k === 'date' && (label === 'date' || label === 'تاريخ'))
				) {
					new_map[label_map[k]] = df.fieldname;
				}
			}
		});

		if (Object.keys(new_map).length > 0) {
			d.custom_eye_col_map = new_map;
		}
	}

	// نحاول تحميل الكشوفات السابقة للعميل
	load_previous_eye_exams(frm, d);

	d.show();
}

// ========================= جدول الكشوفات في هذه الفاتورة =========================

function render_invoice_exam_table(frm, dialog) {
	const wrapper = dialog.fields_dict.invoice_exams_html.$wrapper;
	wrapper.empty();

	// هنخزن الكشوفات الخاصة بهذه الفاتورة في Array داخل الدialog
	dialog.invoice_exams = dialog.invoice_exams || [];

	const exams = dialog.invoice_exams;

	let html = `
        <div class="mb-2 text-muted small">
            يمكنك إضافة كشف واحد فقط لهذه الفاتورة.
        </div>
        <table class="table table-bordered table-condensed" style="table-layout: fixed; width: 100%;">
            <thead>
                <tr style="background:#f5f5f5;">
                    <th style="width:40px;">#</th>
                    <th style="width:100px;">تاريخ</th>
                    <th>SPH-R</th>
                    <th>CYL-R</th>
                    <th>Axis-R</th>
                    <th>ADD-R</th>
                    <th>PD-R</th>
                    <th>SPH-L</th>
                    <th>CYL-L</th>
                    <th>Axis-L</th>
                    <th>ADD-L</th>
                    <th>PD-L</th>
                    <th style="width:80px;">إجراء</th>
                </tr>
            </thead>
            <tbody>
    `;

	if (!exams.length) {
		html += `
            <tr>
                <td colspan="13" class="text-center text-muted">
                    لا يوجد كشف مسجل بعد لهذه الفاتورة.
                </td>
            </tr>
        `;
	} else {
		exams.forEach((exam, idx) => {
			html += `
                <tr>
                    <td>${idx + 1}</td>
                    <td style="word-wrap: break-word;">${
						frappe.format(exam.date, { fieldtype: 'Date' }) || ''
					}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						exam.sph_r || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						exam.cyl_r || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						exam.axis_r || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						exam.add_r || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						exam.pd_r || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						exam.sph_l || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						exam.cyl_l || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						exam.axis_l || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						exam.add_l || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						exam.pd_l || '',
					)}</td>
                    <td>
                        <button class="btn btn-xs btn-danger si-eye-remove" data-idx="${idx}">
                            ${__('حذف')}
                        </button>
                    </td>
                </tr>
            `;
		});
	}

	html += `
            </tbody>
        </table>
    `;

	wrapper.html(html);

	// حدث حذف الصف
	wrapper.find('.si-eye-remove').on('click', function () {
		const idx = parseInt($(this).attr('data-idx'), 10);
		dialog.invoice_exams.splice(idx, 1);
		render_invoice_exam_table(frm, dialog);
	});
}

// يقرأ القيم من الفورم "كشف جديد" ويحطها في Array الخاصة بالفاتورة
function set_exam_on_sales_invoice(dialog) {
	const values = dialog.get_values();

	const exam_data = {
		date: values.exam_date || frappe.datetime.get_today(),
		sph_r: values.sph_r,
		cyl_r: values.cyl_r,
		axis_r: values.axis_r,
		add_r: values.add_r,
		pd_r: values.pd_r,

		sph_l: values.sph_l,
		cyl_l: values.cyl_l,
		axis_l: values.axis_l,
		add_l: values.add_l,
		pd_l: values.pd_l,
	};

	dialog.invoice_exams = dialog.invoice_exams || [];

	if (dialog.invoice_exams.length >= 1) {
		frappe.throw(__('لا يمكن إضافة أكثر من صف واحد في جدول الكشوفات لهذه الفاتورة.'));
	}

	dialog.invoice_exams.push(exam_data);
}

// ========================= حفظ كشف جديد (على العميل وعلى الفاتورة) =========================

function save_new_exam(frm, dialog) {
	const v = dialog.get_values();
	if (!v) return;

	// أولاً: نحط الكشف في جدول الفاتورة (Array) ونمنع أكتر من واحد
	try {
		if (!dialog.invoice_exams || !dialog.invoice_exams.length) {
			set_exam_on_sales_invoice(dialog);
		}
	} catch (e) {
		frappe.msgprint({
			title: __('تحذير'),
			message: e.message || e,
			indicator: 'orange',
		});
		return;
	}

	const exam = dialog.invoice_exams[0];

	// تانيًا: نحفظ الكشف في جدول العميل (Customer.child table) لو عندك صلاحية
	frappe.call({
		method: 'frappe.client.get',
		args: {
			doctype: 'Customer',
			name: frm.doc.customer,
		},
		callback(r) {
			const customer = r.message;
			if (!customer) return;

			const target_field = dialog.custom_eye_table_field || CUSTOMER_EXAMS_CHILD_FIELD;
			const FN = dialog.custom_eye_col_map || EYE_EXAM_FIELDNAMES;

			customer[target_field] = customer[target_field] || [];

			// Check for duplicates before pushing
			// Find an existing exam on the same date (if any)
			const existingExam = customer[target_field].find(
				(existing) => existing[FN.date] === exam.date,
			);

			// If an existing exam is found, handle based on its source.
			// If the current Sales Invoice was created from a Sales Order, prefer to set/update the `so`
			// property on the existing customer exam rather than adding a duplicate.
			const originating_so = frm.doc.sales_order || frm.doc.so || null;

			if (existingExam) {
				if (existingExam.so) {
					console.info(
						'Existing exam on same date already recorded from Sales Order; skipping save to Customer.',
					);
					finish_save();
					return;
				}

				// If this invoice was created from an SO, and the existing exam lacks `so`, update it.
				if (originating_so) {
					try {
						existingExam.so = originating_so;
						// Persist the change to the Customer doc so future logic recognizes the source.
						customer[target_field] = customer[target_field] || [];
						// find index and replace reference to ensure the array is updated
						const idx = customer[target_field].findIndex(
							(e) => e[FN.date] === existingExam[FN.date],
						);
						if (idx >= 0) {
							customer[target_field][idx] = existingExam;
						}

						frappe.call({
							method: 'frappe.client.save',
							args: { doc: customer },
							callback() {
								console.info('Updated existing customer exam with SO reference.');
								finish_save();
							},
							error(err) {
								console.warn(
									'Failed to update existing customer exam with SO',
									err,
								);
								finish_save();
							},
						});
						return;
					} catch (e) {
						console.warn('Could not attach SO to existing exam', e);
						finish_save();
						return;
					}
				}

				// If we have an existing exam and there's no originating SO, skip adding a duplicate.
				console.info(
					'Existing exam on same date found in Customer; skipping add and linking to invoice.',
				);
				finish_save();
				return;
			}

			// No existing exam for that date — safe to add
			if (!existingExam) {
				// نضيف صف جديد في جدول العميل
				customer[target_field].push({
					doctype: 'Eye Prescription',
					parent: customer.name,
					parenttype: 'Customer',
					parentfield: target_field,

					[FN.date]: exam.date,
					[FN.sph_r]: exam.sph_r,
					[FN.cyl_r]: exam.cyl_r,
					[FN.axis_r]: exam.axis_r,
					[FN.add_r]: exam.add_r,
					[FN.pd_r]: exam.pd_r,

					[FN.sph_l]: exam.sph_l,
					[FN.cyl_l]: exam.cyl_l,
					[FN.axis_l]: exam.axis_l,
					[FN.add_l]: exam.add_l,
					[FN.pd_l]: exam.pd_l,

					so: frm.doc.name || '', // Note: Storing Invoice Name in 'so' field if that's what's available
				});

				frappe.call({
					method: 'frappe.client.save',
					args: { doc: customer },
					callback() {
						frappe.msgprint({
							title: __('تم الحفظ'),
							message: __('تم حفظ الكشف الجديد في الفاتورة وفي ملف العميل.'),
							indicator: 'green',
						});
						finish_save();
					},
				});
			} else {
				// Duplicate found in customer records — continue silently and link to invoice
				console.info(
					'Eye exam duplicate detected in customer record; linking to invoice silently.',
				);
				finish_save();
			}

			function finish_save() {
				// نحاول نربط الكشف في جدول الفاتورة الحقيقي
				link_exam_to_sales_invoice_child(frm, exam, dialog.custom_eye_col_map);

				// نرسم الجدول تاني
				render_invoice_exam_table(frm, dialog);

				// نعيد تحميل الكشوفات السابقة
				load_previous_eye_exams(frm, dialog);
			}

			// If this exam was selected from existing customer records, do NOT save/update the
			// customer record again. Just link the exam to the sales invoice and refresh UI.
			if (exam.__from_customer) {
				try {
					link_exam_to_sales_invoice_child(frm, exam, dialog.custom_eye_col_map);
				} catch (err) {
					console.warn(
						'[sales_invoice.js] method: save_new_exam - linking existing exam failed',
						err,
					);
				}
				render_invoice_exam_table(frm, dialog);
				load_previous_eye_exams(frm, dialog);
				return;
			}
		},
		error(err) {
			console.error('Error saving exam on customer', err);
			frappe.msgprint({
				title: __('خطأ'),
				message: __('تعذر حفظ الكشف في ملف العميل (ربما مشكلة صلاحيات).'),
				indicator: 'red',
			});

			// حتى لو فشل حفظه في العميل، نحتفظ به على مستوى الفاتورة فقط
			link_exam_to_sales_invoice_child(frm, exam, dialog.custom_eye_col_map);
			render_invoice_exam_table(frm, dialog);
		},
	});
}

// ربط الكشف بجدول child في الفاتورة لو الفيلد موجود
function link_exam_to_sales_invoice_child(frm, exam, field_map) {
	const fn = INVOICE_EXAMS_CHILD_FIELD;
	if (!fn || !frm.fields_dict[fn]) {
		console.warn('Eye Prescription child table not found on Sales Invoice, skipping link.');
		return;
	}

	frm.doc[fn] = frm.doc[fn] || [];

	// نسمح بصف واحد فقط
	if (frm.doc[fn].length > 1) {
		frappe.throw(__('لا يمكن إضافة أكثر من صف واحد في جدول الكشوفات للفاتورة.'));
	}

	let row;
	if (frm.doc[fn].length === 0) {
		row = frm.add_child(fn);
	} else {
		row = frm.doc[fn][0];
	}

	const FN = field_map || EYE_EXAM_FIELDNAMES;

	row[FN.date] = exam.date;
	row[FN.sph_r] = exam.sph_r;
	row[FN.cyl_r] = exam.cyl_r;
	row[FN.axis_r] = exam.axis_r;
	row[FN.add_r] = exam.add_r;
	row[FN.pd_r] = exam.pd_r;

	row[FN.sph_l] = exam.sph_l;
	row[FN.cyl_l] = exam.cyl_l;
	row[FN.axis_l] = exam.axis_l;
	row[FN.add_l] = exam.add_l;
	row[FN.pd_l] = exam.pd_l;

	frm.refresh_field(fn);
}

// ========================= تحميل الكشوفات السابقة للعميل =========================

function load_previous_eye_exams(frm, dialog) {
	const wrapper = dialog.fields_dict.previous_exams_html.$wrapper;
	wrapper.empty();

	if (!frm.doc.customer) {
		wrapper.html(`<div class="text-muted small">من فضلك اختر العميل أولاً.</div>`);
		return;
	}

	// نحاول نجيب الكشوفات من جدول العميل نفسه
	frappe.call({
		method: 'frappe.client.get',
		args: {
			doctype: 'Customer',
			name: frm.doc.customer,
		},
		callback(r) {
			const customer = r.message;
			if (!customer) {
				wrapper.html(
					`<div class="text-muted small">لم يتم العثور على بيانات العميل.</div>`,
				);
				return;
			}

			const target_field = dialog.custom_eye_table_field || CUSTOMER_EXAMS_CHILD_FIELD;
			let arr = customer[target_field] || [];
			const FN = dialog.custom_eye_col_map || EYE_EXAM_FIELDNAMES;

			if (!arr.length) {
				wrapper.html(
					`<div class="text-muted small">لا توجد كشوفات سابقة لهذا العميل.</div>`,
				);
				return;
			}

			let html = `
                <table class="table table-bordered table-condensed" style="table-layout: fixed; width: 100%;">
                    <thead>
                        <tr style="background:#f5f5f5;">
                            <th style="width:40px;">#</th>
                            <th style="width:100px;">تاريخ</th>
                            <th>SPH-R</th>
                            <th>CYL-R</th>
                            <th>Axis-R</th>
                            <th>ADD-R</th>
                            <th>PD-R</th>
                            <th>SPH-L</th>
                            <th>CYL-L</th>
                            <th>Axis-L</th>
                            <th>ADD-L</th>
                            <th>PD-L</th>
                            <th style="width:80px;">اختيار</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

			arr.forEach((row, idx) => {
				html += `
                    <tr>
                        <td>${idx + 1}</td>
                        <td style="word-wrap: break-word;">${
							frappe.format(row[FN.date], { fieldtype: 'Date' }) || ''
						}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.sph_r] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.cyl_r] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.axis_r] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.add_r] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.pd_r] || '',
						)}</td>

                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.sph_l] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.cyl_l] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.axis_l] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.add_l] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.pd_l] || '',
						)}</td>

                        <td>
                            <button class="btn btn-xs btn-primary si-eye-use" data-idx="${idx}">
                                ${__('استخدام')}
                            </button>
                        </td>
                    </tr>
                `;
			});

			html += `
                    </tbody>
                </table>
            `;

			wrapper.html(html);

			// عند الضغط على "استخدام" ننسخ الكشف إلى الجزء العلوي وإلى جدول الفاتورة
			wrapper.find('.si-eye-use').on('click', function () {
				const idx = parseInt($(this).attr('data-idx'), 10);
				const row = arr[idx];

				const exam = {
					date: row[FN.date],
					sph_r: row[FN.sph_r],
					cyl_r: row[FN.cyl_r],
					axis_r: row[FN.axis_r],
					add_r: row[FN.add_r],
					pd_r: row[FN.pd_r],

					sph_l: row[FN.sph_l],
					cyl_l: row[FN.cyl_l],
					axis_l: row[FN.axis_l],
					add_l: row[FN.add_l],
					pd_l: row[FN.pd_l],
				};
				// mark that this exam came from customer's existing records
				exam.__from_customer = true;

				// نملأ الفورم العلوي بالكشف المختار
				dialog.set_value('exam_date', exam.date);
				dialog.set_value('sph_r', exam.sph_r);
				dialog.set_value('cyl_r', exam.cyl_r);
				dialog.set_value('axis_r', exam.axis_r);
				dialog.set_value('add_r', exam.add_r);
				dialog.set_value('pd_r', exam.pd_r);

				dialog.set_value('sph_l', exam.sph_l);
				dialog.set_value('cyl_l', exam.cyl_l);
				dialog.set_value('axis_l', exam.axis_l);
				dialog.set_value('add_l', exam.add_l);
				dialog.set_value('pd_l', exam.pd_l);

				// نخلي جدول هذه الفاتورة يحتوي هذا الكشف فقط
				dialog.invoice_exams = [exam];
				render_invoice_exam_table(frm, dialog);

				// ونربطه بجدول الفاتورة
				link_exam_to_sales_invoice_child(frm, exam, dialog.custom_eye_col_map);
			});
		},
		error(err) {
			console.error('Error loading previous eye exams', err);
			wrapper.html(`
                <div class="text-danger small">
                    تعذر تحميل الكشوفات السابقة (صلاحيات أو مشكلة في الاتصال).
                </div>
            `);
		},
	});
}

//
frappe.ui.form.on('Sales Invoice', {
	calculate_taxes_only: function (frm) {
		let total_tax = 0;

		// اجمع فقط الضرائب من جدول taxes
		if (frm.doc.taxes) {
			frm.doc.taxes.forEach((tax) => {
				if (
					['On Net Total', 'On Previous Row Amount', 'On Previous Row Total'].includes(
						tax.charge_type,
					)
				) {
					total_tax += tax.tax_amount;
				}
			});
		}

		// ضع القيمة في الحقل المخصص
		frm.set_value('custom_total_taxes', total_tax);
	},

	// يحدث التحديث عند تحميل أو تعديل أي بند أو ضريبة
	refresh: function (frm) {
		frm.trigger('calculate_taxes_only');
	},
	taxes_on_change: function (frm) {
		frm.trigger('calculate_taxes_only');
	},
	items_on_change: function (frm) {
		frm.trigger('calculate_taxes_only');
	},
});

//

frappe.ui.form.on('Sales Invoice', {
	validate: function (frm) {
		let total = 0;
		(frm.doc.items || []).forEach((row) => {
			row.custom_total_price_list = (row.price_list_rate || 0) * (row.qty || 0);
			total += row.custom_total_price_list;
		});
		frm.set_value('custom_total_table', total);
	},
});

frappe.ui.form.on('Sales Invoice Item', {
	price_list_rate: function (frm, cdt, cdn) {
		recalc_row_and_total(frm, cdt, cdn);
	},
	qty: function (frm, cdt, cdn) {
		recalc_row_and_total(frm, cdt, cdn);
	},
});

function recalc_row_and_total(frm, cdt, cdn) {
	let row = frappe.get_doc(cdt, cdn);
	row.custom_total_price_list = (row.price_list_rate || 0) * (row.qty || 0);

	let total = 0;
	(frm.doc.items || []).forEach((r) => {
		total += r.custom_total_price_list || 0;
	});
	frm.set_value('custom_total_table', total);
	frm.refresh_field('custom_total_table');
}
//
frappe.ui.form.on('Sales Invoice', {
	onload(frm) {
		// جعل الحقول قراءة فقط عند تحميل الفورم
		frm.set_df_property('custom_customer_amount', 'read_only', 1);
		frm.set_df_property('custom_company_amount', 'read_only', 1);
		frm.set_df_property('custom_total_insurance', 'read_only', 1);
	},
	custom_customer_amount(frm) {
		calculate_total_insurance(frm);
	},
	custom_company_amount(frm) {
		calculate_total_insurance(frm);
	},
});

function calculate_total_insurance(frm) {
	const customer_amount = frm.doc.custom_customer_amount || 0;
	const company_amount = frm.doc.custom_company_amount || 0;
	frm.set_value('custom_total_insurance', customer_amount + company_amount);
}
//
// ================================
// ✅ تحديث إجمالي الخصم في Sales Invoice
// ================================

frappe.ui.form.on('Sales Invoice Item', {
	discount_amount: function (frm, cdt, cdn) {
		update_total_deduction(frm);
	},
	qty: function (frm, cdt, cdn) {
		update_total_deduction(frm);
	},
});

frappe.ui.form.on('Sales Invoice', {
	onload: function (frm) {
		update_total_deduction(frm); // تحديث عند تحميل الفورم
	},
	refresh: function (frm) {
		update_total_deduction(frm); // تحديث عند التحديث
	},
});

function update_total_deduction(frm) {
	let total_deduction = 0;

	(frm.doc.items || []).forEach((item) => {
		let discount = (item.discount_amount || 0) * (item.qty || 0);
		total_deduction += discount;
	});

	// تحديث القيمة داخل الفورم
	frm.set_value('custom_total_deduction', total_deduction);
}
//
// ==========================
// Sales Invoice - إجمالي الخصم في جدول الأصناف
// ==========================

// تحديث جميع الخصومات عند الحفظ
frappe.ui.form.on('Sales Invoice', {
	validate: function (frm) {
		update_all_discounts(frm);
	},
});

// تحديث عند تغيير أي قيم في جدول الأصناف
frappe.ui.form.on('Sales Invoice Item', {
	custom_discount: function (frm, cdt, cdn) {
		update_discount(frm, cdt, cdn);
	},
	custom_discount_percentage: function (frm, cdt, cdn) {
		update_discount(frm, cdt, cdn);
	},
	custom_discount2: function (frm, cdt, cdn) {
		update_discount(frm, cdt, cdn);
	},
	price_list_rate: function (frm, cdt, cdn) {
		update_discount(frm, cdt, cdn);
	},
	qty: function (frm, cdt, cdn) {
		update_discount(frm, cdt, cdn);
	},
});

// --------------------------
// الدالة لحساب الخصم لبند واحد
// --------------------------
function update_discount(frm, cdt, cdn) {
	let row = locals[cdt][cdn];

	// الخصم الأول (custom_discount ÷ qty)
	let val1 = 0;
	if (row.custom_discount && row.qty) {
		val1 = flt(row.custom_discount) / flt(row.qty);
	}

	// الخصم الثاني (price_list_rate * النسبة / 100)
	let val2 = 0;
	if (row.price_list_rate && row.custom_discount_percentage) {
		val2 = (flt(row.price_list_rate) * flt(row.custom_discount_percentage)) / 100;
	}

	// الخصم الثالث (custom_discount2 ÷ qty)
	let val3 = 0;
	if (row.custom_discount2 && row.qty) {
		val3 = flt(row.custom_discount2) / flt(row.qty);
	}

	// الجمع بين الخصوم الثلاثة
	let total_discount = val1 + val2 + val3;

	frappe.model.set_value(cdt, cdn, 'discount_amount', total_discount);

	frm.dirty();
}

// --------------------------
// تحديث جميع البنود عند الحفظ
// --------------------------
function update_all_discounts(frm) {
	(frm.doc.items || []).forEach((row) => {
		let val1 = 0;
		if (row.custom_discount && row.qty) {
			val1 = flt(row.custom_discount) / flt(row.qty);
		}

		let val2 = 0;
		if (row.price_list_rate && row.custom_discount_percentage) {
			val2 = (flt(row.price_list_rate) * flt(row.custom_discount_percentage)) / 100;
		}

		// الخصم الثالث (custom_discount2 ÷ qty)
		let val3 = 0;
		if (row.custom_discount2 && row.qty) {
			val3 = flt(row.custom_discount2) / flt(row.qty);
		}

		frappe.model.set_value(row.doctype, row.name, 'discount_amount', val1 + val2 + val3);
	});
}
//
frappe.ui.form.on('Sales Invoice', {
	refresh: function (frm) {
		frm.add_custom_button('📤 إرسال الخصم الإضافي عبر SMS', async function () {
			let messages = [];
			let branch = frm.doc.branch || 'غير محدد';

			// اجمع كل الأصناف ذات الخصم غير المعتمد
			(frm.doc.items || []).forEach((item) => {
				if (item.custom_discount2 > 0 && !item.custom_discount2_approved) {
					let subject =
						`👓️ خصم ${format_currency(
							item.custom_discount2,
							frm.doc.currency || 'SAR',
						)} يتطلب الموافقة\n` +
						`الصنف: ${item.item_code}\n` +
						`كود الخصم: ${item.custom_discount_code || 'غير متوفر'}\n` +
						`الفرع: ${branch}`;
					messages.push(subject);
				}
			});

			if (!messages.length) {
				frappe.msgprint('❗ لا توجد خصومات غير معتمدة.');
				return;
			}

			// اجلب قائمة الموظفين النشطين
			frappe.db
				.get_list('Employee', {
					fields: ['name', 'employee_name'],
					filters: { status: 'Active' },
					limit: 100,
				})
				.then((employees) => {
					if (!employees.length) {
						frappe.msgprint('❗ لا يوجد موظفين نشطين.');
						return;
					}

					frappe.prompt(
						[
							{
								label: 'اختر الموظف',
								fieldname: 'employee',
								fieldtype: 'Link',
								options: 'Employee',
								reqd: 1,
							},
						],
						function (values) {
							// بعد اختيار الموظف، اجلب رقم الهاتف الخاص به
							frappe.db
								.get_value('Employee', values.employee, 'cell_number')
								.then((res) => {
									const phone = res.message.cell_number;
									if (!phone) {
										frappe.msgprint('❗ لا يوجد رقم جوال محفوظ لهذا الموظف.');
										return;
									}

									let sales_invoice_link = `${
										window.location.origin
									}/app/sales-invoice/${encodeURIComponent(frm.doc.name)}`;
									let full_message =
										messages.join('\n\n') +
										`\n\n📌 رابط الفاتورة:\n${sales_invoice_link}`;
									let phone_list = [phone.trim()];

									frappe.call({
										method: 'frappe.core.doctype.sms_settings.sms_settings.send_sms',
										args: {
											receiver_list: phone_list,
											msg: full_message,
										},
										callback: function (res) {
											frappe.msgprint(
												'📨 تم إرسال الرسالة بنجاح إلى الموظف.',
											);
										},
										error: function (err) {
											frappe.msgprint(
												'❌ فشل إرسال الرسالة. تحقق من إعدادات SMS.',
											);
											console.error(err);
										},
									});
								});
						},
					);
				});
		});
	},
});
//
// ===============================
// Multi Add Button for Native Items Table
// Adds a Multi Add button below the native items child table
// Independent script - no relation to custom_items_table
// Adds items directly to the native items child table
// ===============================

frappe.ui.form.on('Sales Invoice', {
	refresh(frm) {
		// Only add button if items field exists
		if (!frm.fields_dict.items) return;

		// Get the grid object
		const grid = frm.fields_dict.items.grid;
		if (!grid) return;

		// Add Multi Add button below the native items table
		// This button is independent and always shows for native items table
		if (!frm._multi_add_button_added) {
			grid.add_custom_button(
				__('Multi Add Items'),
				function () {
					open_multi_add_dialog_for_native_table(frm);
				},
				'bottom',
			);
			frm._multi_add_button_added = true;
		}
	},
});

// Multi Add dialog for native items table
function open_multi_add_dialog_for_native_table(frm) {
	console.log('[Multi Add Native] Opening dialog', { frm: frm.doc.name });
	const default_wh = frm.doc.set_warehouse || '';

	const d = new frappe.ui.Dialog({
		title: __('Multi Add Items'),
		size: 'large',
		fields: [
			{
				fieldname: 'warehouse',
				label: 'Warehouse',
				fieldtype: 'Link',
				options: 'Warehouse',
				default: default_wh,
				reqd: 1,
			},
			{
				fieldname: 'search',
				label: 'Search Item (code / name)',
				fieldtype: 'Data',
			},
			{
				fieldname: 'results',
				fieldtype: 'HTML',
			},
		],
		primary_action_label: __('Add Selected'),
		primary_action(values) {
			if (!frm.doc.customer) {
				frappe.msgprint({ message: __('Please select Customer first'), indicator: 'red' });
				return;
			}
			console.log('[Multi Add Native] Add Selected clicked', {
				values,
				warehouse: values.warehouse,
			});
			const $tbody = $(d.get_field('results').$wrapper).find('tbody');
			let added_count = 0;

			const rows_to_add = [];
			$tbody.find('tr[data-item-code]').each(function () {
				const $r = $(this);
				const qty = parseFloat($r.find('.multi-qty').val()) || 0;
				const item_code = $r.attr('data-item-code');
				console.log('[Multi Add Native] Checking row', { item_code, qty });

				if (!qty || qty <= 0) {
					console.log('[Multi Add Native] Skipping row - qty is 0 or invalid', {
						item_code,
						qty,
					});
					return;
				}

				if (!item_code) {
					console.log('[Multi Add Native] Skipping row - no item_code', { item_code });
					return;
				}

				rows_to_add.push({ item_code, qty, warehouse: values.warehouse || '' });
			});

			console.log('[Multi Add Native] Rows to add', rows_to_add);

			// Add items to native items table
			// Use a promise chain to ensure items are added sequentially
			let promise_chain = Promise.resolve();

			rows_to_add.forEach((row_data) => {
				promise_chain = promise_chain.then(() => {
					console.log('[Multi Add Native] Adding row to native table', row_data);

					return new Promise((resolve) => {
						// Add child row to native items table
						const child = frm.add_child('items');
						child.qty = row_data.qty;
						child.warehouse = row_data.warehouse || frm.doc.set_warehouse || '';
						child.delivery_date =
							frm.doc.delivery_date ||
							frm.doc.transaction_date ||
							frappe.datetime.nowdate();

						// Set item_code which will trigger item_code change event to fetch details
						frappe.model
							.set_value(child.doctype, child.name, 'item_code', row_data.item_code)
							.then(() => {
								added_count++;
								resolve();
							});
					});
				});
			});

			promise_chain.then(() => {
				console.log('[Multi Add Native] Total rows added', added_count);

				if (added_count > 0) {
					// Refresh the items field to show the new rows
					frm.refresh_field('items');
					frappe.show_alert({
						message: __('{0} item(s) added', [added_count]),
						indicator: 'green',
					});
				}
			});

			d.hide();
		},
	});

	const results_html = $(`
        <div style="max-height:400px;overflow:auto;">
            <table style="width:100%;border-collapse:collapse;border:1px solid #d1d8dd;">
                <thead>
                    <tr style="background-color:#f5f5f5;">
                        <th style="padding:8px;border:1px solid #d1d8dd;text-align:left;">Item Code</th>
                        <th style="padding:8px;border:1px solid #d1d8dd;text-align:left;">Item Name</th>
                        <th style="padding:8px;border:1px solid #d1d8dd;text-align:left;">Available Qty</th>
                        <th style="padding:8px;border:1px solid #d1d8dd;text-align:left;width:80px;">Qty</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>
    `);
	d.get_field('results').$wrapper.html(results_html);
	const $tbody = results_html.find('tbody');

	const search_field = d.get_field('search');
	search_field.df.onchange = () => {
		const txt = search_field.get_value();
		const wh = d.get_value('warehouse');
		if (!txt || !wh) return;
		search_items_with_stock_for_native(txt, wh, $tbody);
	};

	d.show();
}

// Search items + stock for native items table
function search_items_with_stock_for_native(txt, warehouse, $tbody) {
	console.log('[Search Items Native] Starting search', { txt, warehouse });
	$tbody.empty();

	frappe.call({
		method: 'frappe.desk.search.search_link',
		args: {
			doctype: 'Item',
			txt: txt,
			page_length: 20,
		},
		callback(r) {
			const results = r.results || r.message || [];
			console.log('[Search Items Native] Search results', {
				count: results.length,
				results,
			});
			if (!results.length) {
				console.log('[Search Items Native] No items found');
				$tbody.append(
					'<tr><td colspan="4" style="padding:8px;text-align:center;color:#999;">No Items Found</td></tr>',
				);
				return;
			}

			const item_codes = results.map((x) => x.value);
			console.log('[Search Items Native] Item codes to check stock', item_codes);

			frappe.call({
				method: 'frappe.client.get_list',
				args: {
					doctype: 'Bin',
					filters: { warehouse: warehouse, item_code: ['in', item_codes] },
					fields: ['item_code', 'actual_qty', 'reserved_qty'],
					limit_page_length: 100,
				},
				callback(b) {
					const bins = {};
					(b.message || []).forEach((bin) => {
						bins[bin.item_code] = (bin.actual_qty || 0) - (bin.reserved_qty || 0);
					});

					results.forEach((rw) => {
						const available = bins[rw.value] || 0;
						const tr = $(`
                            <tr data-item-code="${
								rw.value
							}" style="border-bottom:1px solid #e0e0e0;" onmouseover="this.style.backgroundColor='#f9f9f9';" onmouseout="this.style.backgroundColor='transparent';">
                                <td style="padding:8px;border:1px solid #d1d8dd;">${rw.value}</td>
                                <td style="padding:8px;border:1px solid #d1d8dd;">${frappe.utils.escape_html(
									rw.description || rw.value,
								)}</td>
                                <td style="padding:8px;border:1px solid #d1d8dd;">${available.toFixed(
									2,
								)}</td>
                                <td style="padding:8px;border:1px solid #d1d8dd;"><input type="number" class="multi-qty" step="0.001" value="0" style="width:100%;padding:4px 6px;height:28px;font-size:12px;box-sizing:border-box;border:1px solid #d1d8dd;border-radius:3px;"></td>
                            </tr>
                        `);
						$tbody.append(tr);
					});
				},
			});
		},
	});
}
//
frappe.ui.form.on('Sales Invoice', {
	refresh: function (frm) {
		if (frm.doc.docstatus === 1) {
			// التأكد من أن الفاتورة Submitted فقط
			frm.add_custom_button(__('Invoice✨Discount'), function () {
				if (
					!frm.doc.custom_discount_after_submit ||
					frm.doc.custom_discount_after_submit <= 0
				) {
					frappe.msgprint(__('No discount amount to process.'));
					return;
				}

				if (frm.doc.outstanding_amount <= 0) {
					frappe.msgprint(__('لا يمكن الخصم العميل حسابة صفر.'));
					return;
				}

				let discount_amount = frm.doc.custom_discount_after_submit;
				let total_taxes = frm.doc.total_taxes_and_charges || 0; // التحقق من وجود ضريبة
				let net_total = frm.doc.net_total;

				if (net_total <= 0) {
					frappe.msgprint(__('خطأ: إجمالي الأصناف غير صحيح.'));
					return;
				}

				let tax_deducted = 0;
				let net_discount = discount_amount;

				// في حالة وجود ضرائب، يتم احتساب الجزء الخاص بها
				if (total_taxes > 0) {
					let tax_rate = total_taxes / net_total;
					tax_deducted = discount_amount * tax_rate;
					net_discount = discount_amount - tax_deducted;
				}

				// التحقق من توازن القيد قبل الإدراج
				let total_credit = discount_amount;
				let total_debit = tax_deducted + net_discount;

				if (Math.abs(total_credit - total_debit) > 0.01) {
					frappe.msgprint(
						__('خطأ في توزيع القيد: الدائن ({0}) لا يساوي المدين ({1}).', [
							total_credit,
							total_debit,
						]),
					);
					return;
				}

				// تجهيز الحسابات المالية
				let accounts = [
					{
						account: '1310 - مدينون - AS',
						party_type: 'Customer',
						party: frm.doc.customer,
						credit_in_account_currency: discount_amount,
						reference_type: 'Sales Invoice',
						reference_name: frm.doc.name,
					},
					{
						account: '5114 - خصم مسموح به - AS',
						debit_in_account_currency: net_discount,
					},
				];

				// إضافة حساب الضريبة فقط في حالة وجود ضرائب
				if (tax_deducted > 0) {
					accounts.push({
						account: 'GST - AS',
						debit_in_account_currency: tax_deducted,
					});
				}

				frappe.call({
					method: 'frappe.client.insert',
					args: {
						doc: {
							doctype: 'Journal Entry',
							posting_date: frappe.datetime.nowdate(),
							cheque_no: frm.doc.name,
							cheque_date: frm.doc.posting_date,
							accounts: accounts,
						},
					},
					callback: function (response) {
						if (response.message) {
							let journal_entry_no = response.message.name;
							let journal_entry_date = response.message.posting_date;

							frappe.msgprint(__('Journal Entry Created: ' + journal_entry_no));

							frappe.db
								.get_value('Sales Invoice', frm.doc.name, 'custom_discount_qty')
								.then((r) => {
									let current_qty = r.message.custom_discount_qty || 0;
									let new_discount_qty = parseInt(current_qty) + 1;

									frappe.call({
										method: 'frappe.client.set_value',
										args: {
											doctype: 'Sales Invoice',
											name: frm.doc.name,
											fieldname: {
												custom_discount_entry_no: journal_entry_no,
												custom_discount_date: journal_entry_date,
												custom_discount_qty: new_discount_qty,
											},
										},
										callback: function (res) {
											if (!res.exc) {
												frm.reload_doc();
											}
										},
									});
								});
						}
					},
				});
			}).addClass('btn-danger');
		}
	},
});
//
frappe.ui.form.on('Sales Invoice', {
	onload: function (frm) {
		if (!frm.doc.custom_sales_order && frm.doc.items.length > 0) {
			let sales_order = frm.doc.items[0].sales_order; // الحصول على أول أمر بيع مرتبط بالمادة

			if (sales_order) {
				frm.set_value('custom_sales_order', sales_order);
				frm.refresh_field('custom_sales_order');

				// جلب delivery_date من أمر البيع
				frappe.db.get_value('Sales Order', sales_order, 'delivery_date', function (value) {
					if (value && value.delivery_date) {
						frm.set_value('custom_delivery_date', value.delivery_date);
						frm.refresh_field('custom_delivery_date');
					}
				});
			}
		}

		// جعل الحقل للقراءة فقط
		frm.set_df_property('custom_sales_order', 'read_only', 1);
	},
});
//
frappe.ui.form.on('Sales Invoice', {
	setup(frm) {
		apply_invoice_order_type_visibility(frm);
	},
	refresh(frm) {
		apply_invoice_order_type_visibility(frm);
	},
	onload(frm) {
		apply_invoice_order_type_visibility(frm);
	},
});

function apply_invoice_order_type_visibility(frm) {
	const roles = (frappe.user_roles || []).map((r) => (r || '').trim());

	const hasSales = roles.includes('مبيعات');
	const hasWholesale = roles.includes('مبيعات جمله');

	// حدّد اسم الحقل اللي موجود عندك فعلاً
	const fieldname = get_existing_field(frm, ['order_type', 'custom_order_type']);
	if (!fieldname) return; // لو مفيش حقل، خلاص مفيش حاجة نتحكم فيها

	// لو معاه الاتنين خليه يشوف الكل
	if (hasSales && hasWholesale) {
		set_select_options(frm, fieldname, ['Sales', 'Insurance', 'WholeSale']);
		return;
	}

	// مبيعات جمله: Wholesale فقط
	if (hasWholesale) {
		set_select_options(frm, fieldname, ['WholeSale']);
		force_if_invalid(frm, fieldname, ['WholeSale'], 'WholeSale');
		return;
	}

	// مبيعات: Sales + Insurance
	if (hasSales) {
		set_select_options(frm, fieldname, ['Sales', 'Insurance']);
		force_if_invalid(frm, fieldname, ['Sales', 'Insurance'], 'Sales');
		return;
	}

	// أي حد تاني: Sales فقط (غيّرها لو تحب تمنعهم تمامًا)
	set_select_options(frm, fieldname, ['Sales']);
	force_if_invalid(frm, fieldname, ['Sales'], 'Sales');
}

function get_existing_field(frm, names) {
	for (const n of names) {
		if (frm.fields_dict && frm.fields_dict[n]) return n;
	}
	return null;
}

function set_select_options(frm, fieldname, opts) {
	frm.set_df_property(fieldname, 'options', opts.join('\n'));
	frm.refresh_field(fieldname);
}

function force_if_invalid(frm, fieldname, allowed, fallback) {
	const current = frm.doc[fieldname];
	if (!current || !allowed.includes(current)) {
		frm.set_value(fieldname, fallback);
	}
}
//
frappe.ui.form.on('Sales Invoice', {
	before_submit: function (frm) {
		if (frm.doc.customer && frm.doc.custom_size && frm.doc.custom_size.length > 0) {
			return frappe
				.call({
					method: 'frappe.client.get',
					args: {
						doctype: 'Customer',
						name: frm.doc.customer,
					},
				})
				.then((response) => {
					if (response.message) {
						let customer_doc = response.message;
						let existing_rows = customer_doc.custom_size_t || [];
						let updated_rows = [...existing_rows];
						let conflict_found = false;

						for (let so_row of frm.doc.custom_size) {
							// Try to find an existing customer exam by date
							const existing = existing_rows.find((r) => r.date === so_row.date);

							if (existing) {
								// Reuse existing exam: ensure it's associated with this Sales Invoice
								if (existing.so !== frm.doc.name) {
									// update a copy into updated_rows (do not mutate original fetched object)
									const copy = Object.assign({}, existing, { so: frm.doc.name });
									const idx = updated_rows.findIndex(
										(r) => r.date === copy.date && r.so === frm.doc.name,
									);
									if (idx === -1) {
										updated_rows.push(copy);
									} else {
										updated_rows[idx] = Object.assign(
											{},
											updated_rows[idx],
											copy,
										);
									}
								}

								// Do not create a new customer record for this exam — invoice will reference existing data
								continue;
							}

							// No existing customer exam found — prepare to add one linked to this invoice
							let row_data = {
								date: so_row.date,
								sphr: so_row.sphr,
								cylr: so_row.cylr,
								axisr: so_row.axisr,
								addr: so_row.addr,
								pdr: so_row.pdr,
								sphl: so_row.sphl,
								cyll: so_row.cyll,
								axisl: so_row.axisl,
								addl: so_row.addl,
								pdl: so_row.pdl,
								so: frm.doc.name,
							};

							let existing_index = updated_rows.findIndex(
								(r) => r.so === frm.doc.name && r.date === so_row.date,
							);

							if (existing_index !== -1) {
								updated_rows[existing_index] = Object.assign(
									{},
									updated_rows[existing_index],
									row_data,
								);
							} else {
								updated_rows.push(row_data);
							}
						}

						// إذا لم يوجد تعارض، نقوم بالحفظ في سجل العميل
						if (!conflict_found) {
							return frappe.call({
								method: 'frappe.client.set_value',
								args: {
									doctype: 'Customer',
									name: frm.doc.customer,
									fieldname: {
										custom_size_t: updated_rows,
									},
								},
							});
						}
					}
				});
		}
	},
});
//
// Client Script — Doctype: "Sales Invoice"
frappe.ui.form.on('Sales Invoice', {
	validate: function (frm) {
		let errors = [];

		for (let row of frm.doc.custom_payment || []) {
			// تحقق من وجود طريقة الدفع والمبلغ معًا
			if (row.mode_of_payment && (!row.amount || row.amount === 0)) {
				errors.push(__(`السطر #{0}: عند تحديد طريقة الدفع يجب إدخال المبلغ.`, [row.idx]));
			}

			if (row.amount && (!row.mode_of_payment || row.mode_of_payment.trim() === '')) {
				errors.push(__(`السطر #{0}: عند إدخال المبلغ يجب تحديد طريقة الدفع.`, [row.idx]));
			}
		}

		if (errors.length > 0) {
			frappe.msgprint(errors.join('<br>'));
			frappe.validated = false;
		}
	},

	on_submit: function (frm) {
		const create_payment_entry = (row) => {
			frappe.call({
				method: 'frappe.client.get_value',
				args: {
					doctype: 'Mode of Payment',
					filters: { name: row.mode_of_payment },
					fieldname: 'custom_account',
				},
				callback: function (res) {
					let account = res.message && res.message.custom_account;

					if (!account) {
						frappe.msgprint(
							__(
								'لا يوجد حساب مخصص في "طريقة الدفع" "{0}". الرجاء التحقق من تعبئة الحقل "custom_account".',
								[row.mode_of_payment],
							),
						);
						return;
					}

					let payment_entry = {
						doctype: 'Payment Entry',
						payment_type: 'Receive',
						company: frm.doc.company,

						mode_of_payment: row.mode_of_payment,
						paid_amount: row.amount,
						received_amount: row.amount,

						paid_to: account,
						paid_from: frm.doc.debit_to || '',

						posting_date: frm.doc.posting_date,
						party_type: 'Customer',
						party: frm.doc.customer || '',

						reference_no: row.reference_no || '',
						reference_date: frm.doc.posting_date,

						references: [
							{
								reference_doctype: 'Sales Invoice',
								reference_name: frm.doc.name,
								total_amount: frm.doc.grand_total,
								outstanding_amount: row.amount,
								allocated_amount: row.amount,
							},
						],
					};

					frappe.call({
						method: 'frappe.client.insert',
						args: { doc: payment_entry },
						callback: function (r) {
							if (r.message) {
								frappe.call({
									method: 'frappe.client.submit',
									args: { doc: r.message },
									callback: function (submit_r) {
										if (submit_r.message) {
											frappe.msgprint(
												__(
													'✅ تم إنشاء سند الدفع <b>{0}</b> للمبلغ <b>{1}</b>.',
													[
														submit_r.message.name,
														format_currency(
															row.amount,
															frm.doc.currency,
														),
													],
												),
											);
										}
									},
								});
							}
						},
					});
				},
			});
		};

		// تنفيذ إنشاء سند الدفع لكل صف في جدول الدفعات
		(frm.doc.custom_payment || []).forEach(create_payment_entry);
	},
});
//
// Client Script — Doctype: "Sales Invoice"
frappe.ui.form.on('Sales Invoice', {
	setup(frm) {
		// دالة موحدة لفرض تواريخ الدفع
		frm._force_payment_due_dates = function () {
			if (!frm.doc.payment_schedule || !frm.doc.posting_date) return;

			const tx = frappe.datetime.str_to_obj(frm.doc.posting_date);
			let changed = false;

			(frm.doc.payment_schedule || []).forEach((row) => {
				// إجبار التاريخ ليكون نفس تاريخ الفاتورة دائماً
				if (
					!row.due_date ||
					frappe.datetime.str_to_obj(row.due_date) < tx ||
					row.due_date !== frm.doc.posting_date
				) {
					row.due_date = frm.doc.posting_date;
					changed = true;
				}
			});

			if (changed) frm.refresh_field('payment_schedule');
		};
	},

	onload(frm) {
		// عند فتح الفاتورة (حتى بعد التحويل من أمر البيع)
		frm._force_payment_due_dates();
	},

	refresh(frm) {
		// تأكيد إضافي عند كل ريفرش
		frm._force_payment_due_dates();
	},

	posting_date(frm) {
		// لو المستخدم غيّر تاريخ الفاتورة نعيد ضبط جدول الدفع
		frm._force_payment_due_dates();
	},

	validate(frm) {
		// أهم نقطة: قبل الحفظ مباشرة — يمنع رسالة "لا يمكن أن يكون تاريخ الاستحقاق قبل تاريخ الترحيل"
		frm._force_payment_due_dates();
	},

	before_submit(frm) {
		// تأكيد أخير قبل الإرسال
		frm._force_payment_due_dates();
	},
});
//
// Client Script — Doctype: "Sales Invoice"
frappe.ui.form.on('Sales Invoice', {
	custom_payment_on_form_rendered(frm) {
		// فلترة أوضاع الدفع لتظهر فقط المفعلة
		frm.fields_dict.custom_payment.grid.get_field('mode_of_payment').get_query = function () {
			return {
				filters: { enabled: 1 },
			};
		};
	},
});

frappe.ui.form.on('Sales Invoice Payment', {
	mode_of_payment: async function (frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		if (row.mode_of_payment && frm.doc.company) {
			try {
				// نحمل سجل Mode of Payment نفسه (بدون الوصول إلى Mode of Payment Account مباشرة)
				const mop = await frappe.db.get_doc('Mode of Payment', row.mode_of_payment);

				if (mop && mop.accounts && mop.accounts.length > 0) {
					// نحاول إيجاد الحساب الافتراضي لنفس الشركة
					const account_row = mop.accounts.find((a) => a.company === frm.doc.company);

					if (account_row && account_row.default_account) {
						frappe.model.set_value(cdt, cdn, 'account', account_row.default_account);
					} else {
						frappe.model.set_value(cdt, cdn, 'account', null);
						frappe.msgprint(
							__(
								'لم يتم العثور على الحساب الافتراضي لهذا النوع من الدفع لهذه الشركة.',
							),
						);
					}
				} else {
					frappe.model.set_value(cdt, cdn, 'account', null);
					frappe.msgprint(__('لم يتم العثور على إعدادات الحسابات في وضع الدفع.'));
				}
			} catch (e) {
				frappe.msgprint(__('حدث خطأ أثناء جلب بيانات وضع الدفع.'));
				console.error(e);
			}
		}
	},
});
//
frappe.ui.form.on('Sales Invoice', {
	validate: async function (frm) {
		if (frm.doc.custom_order_type !== 'Insurance') return;

		try {
			if (frm.doc.custom_insurance_company) {
				let doc = await frappe.db.get_doc(
					'Insurance Company',
					frm.doc.custom_insurance_company,
				);
				if (doc.custom__apvd_amt2 == 1) {
					await recalculate_insurance_amounts_v1(frm);
					return;
				}
			}

			if (frm.doc.custom_insurance_company) {
				let doc = await frappe.db.get_doc(
					'Insurance Company',
					frm.doc.custom_insurance_company,
				);
				if (doc.custom__apvd_amt == 1) {
					await recalculate_insurance_amounts_v2(frm);
					return;
				}
			}
		} catch (error) {
			console.error('Error in insurance calculation:', error);
			await recalculate_insurance_amounts_v2(frm);
		}

		if (frm.doc.custom_insurance_percentage === 0) {
			frm.set_value('custom_customer_amount', 0);
			frm.set_value('custom_company_amount', 0);
			frm.set_value('discount_amount', 0);
		}
	},

	custom_insurance_percentage: function (frm) {
		if (frm.doc.order_type !== 'Insurance') return;

		if (frm.doc.custom_insurance_percentage === 0) {
			frm.set_value('custom_customer_amount', 0);
			frm.set_value('custom_company_amount', 0);
			frm.set_value('discount_amount', 0);
		}
	},

	custom_maximum_limit: function (frm) {
		if (frm.doc.order_type !== 'Insurance') return;

		if (frm.doc.custom_insurance_percentage === 0) {
			frm.set_value('custom_customer_amount', 0);
			frm.set_value('custom_company_amount', 0);
			frm.set_value('discount_amount', 0);
		}
	},

	custom_approval_amount: function (frm) {
		if (frm.doc.order_type !== 'Insurance') return;

		if (frm.doc.custom_insurance_percentage === 0) {
			frm.set_value('custom_customer_amount', 0);
			frm.set_value('custom_company_amount', 0);
			frm.set_value('discount_amount', 0);
		}
	},

	before_save: async function (frm) {
		if (frm.doc.order_type !== 'Insurance') return;

		try {
			frm.set_value('discount_amount', 0);

			if (frm.doc.custom_insurance_company) {
				let doc = await frappe.db.get_doc(
					'Insurance Company',
					frm.doc.custom_insurance_company,
				);
				if (doc.custom__apvd_amt2 == 1) {
					await recalculate_insurance_amounts_v1(frm);
					return;
				}
			}

			if (frm.doc.custom_insurance_company) {
				let doc = await frappe.db.get_doc(
					'Insurance Company',
					frm.doc.custom_insurance_company,
				);
				if (doc.custom__apvd_amt == 1) {
					await recalculate_insurance_amounts_v2(frm);
					return;
				}
			}
		} catch (error) {
			console.error('Error in before_save:', error);
			await recalculate_insurance_amounts_v2(frm);
		}
	},
});

// الكود الأساسي (يعتمد على custom__apvd_amt2 == 1)
async function recalculate_insurance_amounts_v1(frm) {
	let insurance_company_name = frm.doc.custom_insurance_company;
	if (!insurance_company_name) return;

	let doc = await frappe.db.get_doc('Insurance Company', insurance_company_name);
	if (doc.custom__apvd_amt2 != 1) return;

	let percentage = frm.doc.custom_insurance_percentage || 0;
	let approval_amount = frm.doc.custom_approval_amount || 0;
	let maximum_limit = frm.doc.custom_maximum_limit || 0;
	let custom_contract_discount = frm.doc.custom_contract_discount || 0;

	if (percentage === 0) {
		frm.set_value('custom_customer_amount', 0);
		frm.set_value('custom_company_amount', 0);
		frm.set_value('discount_amount', 0);
		return;
	}

	let calculated_discount =
		(approval_amount - (approval_amount * custom_contract_discount) / 100) *
		(percentage / 100);
	let discount =
		maximum_limit > 0 ? Math.min(calculated_discount, maximum_limit) : calculated_discount;

	let adjusted_amount = approval_amount;
	let insurance_amount = adjusted_amount - approval_amount * (custom_contract_discount / 100);
	let final_insurance_amount = insurance_amount - discount;

	let insurance_difference = frm.doc.total - approval_amount;
	let total_customer_amount = discount + insurance_difference;

	let insurance_account_amount =
		frm.doc.taxes?.find((row) => row.account_head === '1302 - شركات التأمين - AO')
			?.tax_amount || 0;
	let negative_insurance_amount = insurance_account_amount * -1;
	let total_after_insurance = negative_insurance_amount + frm.doc.custom_customer_amount;
	let total_difference = frm.doc.total - total_after_insurance;

	frm.set_value('discount_amount', 0);
	frm.set_value('discount_amount', total_difference);

	if (final_insurance_amount > 0) {
		let negative_final_insurance_amount = final_insurance_amount * -1;
		let insurance_amount_row = frm.doc.taxes?.find(
			(row) => row.description === 'Insurance Amount',
		);
		if (!insurance_amount_row) {
			frm.add_child('taxes', {
				charge_type: 'Actual',
				account_head: '1302 - شركات التأمين - AO',
				description: 'Insurance Amount',
				tax_amount: negative_final_insurance_amount,
			});
		} else {
			insurance_amount_row.tax_amount = negative_final_insurance_amount;
			insurance_amount_row.account_head = '1302 - شركات التأمين - AO';
		}
	}

	frm.refresh_field('taxes');
	let total_taxes_and_charges = frm.doc.taxes.reduce(
		(total, row) => total + (row.tax_amount || 0),
		0,
	);

	frm.set_value('total_taxes_and_charges', total_taxes_and_charges);
	frm.set_value('total', total_taxes_and_charges);
	frm.set_value('custom_company_amount', insurance_account_amount * -1);
	frm.set_value('custom_customer_amount', total_customer_amount);
}

// الكود البديل (يعتمد على custom__apvd_amt == 1)
async function recalculate_insurance_amounts_v2(frm) {
	let insurance_company_name = frm.doc.custom_insurance_company;
	if (!insurance_company_name) return;

	let doc = await frappe.db.get_doc('Insurance Company', insurance_company_name);
	if (doc.custom__apvd_amt != 1) return;

	let percentage = frm.doc.custom_insurance_percentage || 0;
	let approval_amount = frm.doc.custom_approval_amount || 0;
	let maximum_limit = frm.doc.custom_maximum_limit || 0;
	let custom_contract_discount = frm.doc.custom_contract_discount || 0;

	if (percentage === 0) {
		frm.set_value('custom_customer_amount', 0);
		frm.set_value('custom_company_amount', 0);
		frm.set_value('discount_amount', 0);
		return;
	}

	let calculated_discount = approval_amount * (percentage / 100);
	let discount =
		maximum_limit > 0 ? Math.min(calculated_discount, maximum_limit) : calculated_discount;

	let adjusted_amount = approval_amount - discount;
	let insurance_amount = adjusted_amount - adjusted_amount * (custom_contract_discount / 100);
	let final_insurance_amount = insurance_amount;

	let insurance_difference = frm.doc.total - approval_amount;
	let total_customer_amount = discount + insurance_difference;

	let insurance_account_amount =
		frm.doc.taxes?.find((row) => row.account_head === '1302 - شركات التأمين - AO')
			?.tax_amount || 0;
	let negative_insurance_amount = insurance_account_amount * -1;
	let total_after_insurance = negative_insurance_amount + frm.doc.custom_customer_amount;
	let total_difference = frm.doc.total - total_after_insurance;

	frm.set_value('discount_amount', 0);
	frm.set_value('discount_amount', total_difference);

	if (final_insurance_amount > 0) {
		let negative_final_insurance_amount = final_insurance_amount * -1;
		let insurance_amount_row = frm.doc.taxes?.find(
			(row) => row.description === 'Insurance Amount',
		);
		if (!insurance_amount_row) {
			frm.add_child('taxes', {
				charge_type: 'Actual',
				account_head: '1302 - شركات التأمين - AO',
				description: 'Insurance Amount',
				tax_amount: negative_final_insurance_amount,
			});
		} else {
			insurance_amount_row.tax_amount = negative_final_insurance_amount;
			insurance_amount_row.account_head = '1302 - شركات التأمين - AO';
		}
	}

	frm.refresh_field('taxes');
	let total_taxes_and_charges = frm.doc.taxes.reduce(
		(total, row) => total + (row.tax_amount || 0),
		0,
	);

	frm.set_value('total_taxes_and_charges', total_taxes_and_charges);
	frm.set_value('total', total_taxes_and_charges);
	frm.set_value('custom_company_amount', insurance_account_amount * -1);
	frm.set_value('custom_customer_amount', total_customer_amount);
}
//
frappe.ui.form.on('Sales Invoice', {
	customer: function (frm) {
		if (frm.doc.customer) {
			frappe.call({
				method: 'frappe.client.get',
				args: {
					doctype: 'Customer',
					name: frm.doc.customer,
				},
				callback: function (response) {
					if (
						response.message &&
						response.message.custom_insurance_data &&
						response.message.custom_insurance_data.length > 0
					) {
						let insurance_rows = response.message.custom_insurance_data;
						let last_row = insurance_rows[insurance_rows.length - 1];

						frm.clear_table('custom_insurance_data');

						let new_row = frm.add_child('custom_insurance_data');
						const fields_to_copy = [
							'policy_number',
							'category',
							'expiry_date',
							'category_name',
							'id_number',
							'category_type',
							'membership_number',
							'nationality',
							'Age',
							'file_number',
						];
						for (let key of fields_to_copy) {
							new_row[key] = last_row[key];
						}

						frm.refresh_field('custom_insurance_data');
					}
				},
			});
		}
	},

	on_submit: function (frm) {
		if (
			frm.doc.customer &&
			frm.doc.custom__insurance_data &&
			frm.doc.custom_insurance_data.length > 0
		) {
			let sales_row = frm.doc.custom_insurance_data[0];

			frappe.call({
				method: 'frappe.client.get',
				args: {
					doctype: 'Customer',
					name: frm.doc.customer,
				},
				callback: function (response) {
					let customer = response.message;
					if (customer) {
						let insurance_rows = customer.custom_insurance_data || [];
						let last_customer_row =
							insurance_rows.length > 0
								? insurance_rows[insurance_rows.length - 1]
								: null;

						const fields_to_check = [
							'policy_number',
							'category',
							'expiry_date',
							'category_name',
							'id_number',
							'category_type',
							'membership_number',
							'nationality',
							'Age',
							'file_number',
						];

						let is_different = true;

						if (last_customer_row) {
							is_different = false;

							for (let key of fields_to_check) {
								// تنظيف القيم قبل المقارنة
								let val1 = sales_row[key];
								let val2 = last_customer_row[key];

								if (val1 === undefined || val1 === null) val1 = '';
								if (val2 === undefined || val2 === null) val2 = '';

								// إذا كان النص، نفّذ trim وحالة insensitive
								if (typeof val1 === 'string') val1 = val1.trim().toLowerCase();
								if (typeof val2 === 'string') val2 = val2.trim().toLowerCase();

								if (val1 !== val2) {
									is_different = true;
									break;
								}
							}
						}

						if (is_different) {
							let new_row = {};
							for (let key of fields_to_check) {
								new_row[key] = sales_row[key];
							}

							insurance_rows.push(new_row);

							frappe.call({
								method: 'frappe.client.set_value',
								args: {
									doctype: 'Customer',
									name: frm.doc.customer,
									fieldname: {
										custom_insurance_data: insurance_rows,
									},
								},
								callback: function () {
									// تم الحفظ بنجاح
								},
							});
						} else {
							// لا يوجد اختلاف، لا تحفظ
						}
					}
				},
			});
		}
	},
});
//
// ========================= إعدادات عامة =========================

const CUSTOMER_INSURANCE_CHILD_FIELD = 'insurance_data';

// اسم الجدول في فاتورة المبيعات (Sales Invoice)
// عادةً نفس الاسم في Sales Order لو الحقول منقولة
const INVOICE_INSURANCE_CHILD_FIELD = 'custom_insurance_data';

const INSURANCE_FIELDNAMES = {
	company: 'patients_insurance_company_name',
	policy_no: 'policy_number',
	patient_name: 'patient_name',
	id_no: 'id_number',
	gender: 'gender',
	marital_status: 'marital_status',
	berth_date: 'berth_date',
	religion: 'religion',
	current_job: 'current_job',
	category: 'category',
	expiry: 'expiry_date',
	cat_name: 'category_name',
	cat_type: 'category_type',
	mem_no: 'membership_number',
	nationality: 'nationality',
	age: 'age',
	file_no: 'file_number',
	custom_insurance_company: 'custom_insurance_company',
	custom_contract_discount: 'custom_contract_discount',
	custom_approval_number: 'custom_approval_number',
	custom_approval_date: 'custom_approval_date',
	custom_approval_amount: 'custom_approval_amount',
	custom_insurance_percentage: 'custom_insurance_percentage',
	custom_maximum_limit: 'custom_maximum_limit',
};

frappe.ui.form.on('Sales Invoice', {
	refresh(frm) {
		if (frm.page.insurance_btn && !frm.page.insurance_btn.is_destroyed) {
			frm.page.insurance_btn.remove();
		}
		frm.page.insurance_btn = frm.page
			.add_inner_button(__('بيانات التأمين (Insurance Data)'), function () {
				if (!frm.doc.customer) {
					frappe.msgprint({
						title: __('تنبيه'),
						message: __('من فضلك اختر العميل أولاً.'),
						indicator: 'orange',
					});
					return;
				}
				open_insurance_dialog(frm);
			})
			.addClass('btn-info');
	},
});

function open_insurance_dialog(frm) {
	frappe.model.with_doctype('Customer', () => {
		frappe.model.with_doctype('Insurance Data', () => {
			_open_insurance_dialog_logic(frm);
		});
	});
}

function _open_insurance_dialog_logic(frm) {
	// 1. Discover Fields Types to know which are Links
	let field_types = {};
	const meta = frappe.get_meta('Insurance Data');
	if (meta && meta.fields) {
		meta.fields.forEach((df) => {
			field_types[df.fieldname] = {
				type: df.fieldtype,
				options: df.options,
				label: df.label,
			};
		});
	}

	// 2. Discover correct field mapping
	let col_map = Object.assign({}, INSURANCE_FIELDNAMES);
	if (meta && meta.fields) {
		const label_map = {
			company: 'company',
			'insurance company': 'company',
			policy: 'policy_no',
			'patient name': 'patient_name',
			'id number': 'id_no',
			'id no': 'id_no',
			category: 'category',
			expiry: 'expiry',
			'category name': 'cat_name',
			'category type': 'cat_type',
			membership: 'mem_no',
			nationality: 'nationality',
			age: 'age',
			file: 'file_no',

			gender: 'gender',
			marital: 'marital_status',
			birth: 'berth_date',
			religion: 'religion',
			job: 'current_job',

			'approval number': 'custom_approval_number',
			'approval date': 'custom_approval_date',
		};

		meta.fields.forEach((df) => {
			const fieldname = (df.fieldname || '').toLowerCase();
			if (
				fieldname === 'birth_date' ||
				fieldname === 'date_of_birth' ||
				fieldname === 'dob'
			) {
				col_map.berth_date = df.fieldname;
			}

			if (fieldname === 'marital' || fieldname === 'marital_status') {
				col_map.marital_status = df.fieldname;
			}

			if (fieldname === 'gender') col_map.gender = df.fieldname;
			if (fieldname === 'religion') col_map.religion = df.fieldname;
			if (fieldname === 'current_job' || fieldname === 'job' || fieldname === 'occupation')
				col_map.current_job = df.fieldname;
			if (fieldname === 'custom_approval_number')
				col_map.custom_approval_number = df.fieldname;
			if (fieldname === 'custom_approval_date') col_map.custom_approval_date = df.fieldname;

			const label = (df.label || '').toLowerCase();
			for (const k in label_map) {
				if (!label.includes(k)) continue;
				if (k === 'category' && (label.includes('name') || label.includes('type')))
					continue;
				col_map[label_map[k]] = df.fieldname;
			}
		});
	}

	const get_conf = (key, override_label) => {
		const fname = col_map[key];
		let ftype = 'Data';
		let fopt = null;
		let flabel = override_label || key;

		if (field_types[fname]) {
			ftype = field_types[fname].type === 'Link' ? 'Link' : field_types[fname].type;
			fopt = field_types[fname].options;
			flabel = field_types[fname].label;
		} else if (frm.fields_dict[key]) {
			const parent_df = frm.fields_dict[key].df;
			ftype = parent_df.fieldtype;
			fopt = parent_df.options;
			flabel = override_label || parent_df.label;
		} else {
			if (
				key.includes('amount') ||
				key.includes('discount') ||
				key.includes('percentage') ||
				key.includes('limit')
			) {
				ftype = 'Float';
			}
		}

		return { fieldname: key, label: flabel, fieldtype: ftype, options: fopt };
	};

	const d = new frappe.ui.Dialog({
		title: __('بيانات التأمين (Insurance Data) - فاتورة المبيعات'),
		size: 'large',
		fields: [
			{ fieldtype: 'Section Break', label: 'بيانات جديدة 📝' },
			{ fieldtype: 'Column Break' },
			get_conf('company'),
			get_conf('policy_no'),
			get_conf('patient_name'),
			get_conf('id_no'),
			Object.assign(get_conf('gender'), { reqd: 1 }),
			get_conf('marital_status'),

			{ fieldtype: 'Column Break' },
			get_conf('category'),
			{ fieldname: 'expiry', label: 'Expiry Date', fieldtype: 'Date' },
			get_conf('cat_name'),
			get_conf('cat_type'),
			get_conf('berth_date'),
			get_conf('religion'),

			{ fieldtype: 'Column Break' },
			get_conf('mem_no'),
			get_conf('nationality'),
			get_conf('age'),
			get_conf('file_no'),
			get_conf('current_job'),

			{ fieldtype: 'Section Break', label: 'بيانات إضافية (Custom)' },
			{ fieldtype: 'Column Break' },
			get_conf('custom_insurance_company', 'Insurance Company (Custom)'),
			Object.assign(get_conf('custom_contract_discount', 'Contract Discount'), {
				hidden: 1,
			}),
			get_conf('custom_approval_number', 'Approval Number'),
			get_conf('custom_approval_date', 'Approval Date'),
			get_conf('custom_approval_amount', 'Approval Amount'),

			{ fieldtype: 'Column Break' },
			get_conf('custom_insurance_percentage', 'Insurance Percentage'),
			get_conf('custom_maximum_limit', 'Maximum Limit'),

			{ fieldtype: 'Section Break', label: '📜 البيانات المسجلة في هذه الفاتورة' },
			{ fieldname: 'invoice_insurance_html', fieldtype: 'HTML' },
			{ fieldtype: 'Section Break', label: '📂 البيانات السابقة لهذا العميل' },
			{ fieldname: 'previous_insurance_html', fieldtype: 'HTML' },
			{ fieldtype: 'Section Break' },
		],
		primary_action_label: __('حفظ في الفاتورة'),
		primary_action: function () {
			save_new_insurance(frm, d);
		},
	});

	d.custom_ins_col_map = col_map;
	if (d.fields_dict.custom_approval_date) {
		d.set_df_property('custom_approval_date', 'read_only', 1);
		d.set_value('custom_approval_date', frappe.datetime.get_today());
	}
	const is_locked = frm.doc.docstatus === 1 || frm.doc.docstatus === 2;
	if (is_locked) {
		Object.keys(INSURANCE_FIELDNAMES).forEach((fname) => {
			if (d.fields_dict[fname]) d.set_df_property(fname, 'read_only', 1);
		});
		d.set_primary_action(__('إغلاق'), () => d.hide());
	}

	const sync_fields = (f1, f2) => {
		if (d.fields_dict[f1] && d.fields_dict[f2]) {
			d.fields_dict[f1].df.onchange = () => {
				const val = d.get_value(f1);
				if (val !== d.get_value(f2)) {
					d.set_value(f2, val);
				}

				if (frm.fields_dict[f2]) {
					frm.set_value(f2, val).then(() => {
						const discount = frm.doc.custom_contract_discount;
						const amount = frm.doc.custom_approval_amount;
						const percentage = frm.doc.custom_insurance_percentage;
						const limit = frm.doc.custom_maximum_limit;

						if (discount && d.fields_dict.custom_contract_discount)
							d.set_value('custom_contract_discount', discount);
						if (amount && d.fields_dict.custom_approval_amount)
							d.set_value('custom_approval_amount', amount);
						if (percentage && d.fields_dict.custom_insurance_percentage)
							d.set_value('custom_insurance_percentage', percentage);
						if (limit && d.fields_dict.custom_maximum_limit)
							d.set_value('custom_maximum_limit', limit);
					});
				}
			};

			d.fields_dict[f2].df.onchange = () => {
				const val = d.get_value(f2);
				if (val !== d.get_value(f1)) d.set_value(f1, val);

				if (frm.fields_dict[f2]) {
					frm.set_value(f2, val).then(() => {
						const discount = frm.doc.custom_contract_discount;
						if (discount && d.fields_dict.custom_contract_discount)
							d.set_value('custom_contract_discount', discount);
					});
				}
			};
		}
	};

	sync_fields('company', 'custom_insurance_company');

	const direct_sync = (fname) => {
		if (d.fields_dict[fname]) {
			d.fields_dict[fname].df.onchange = () => {
				const val = d.get_value(fname);
				if (frm.fields_dict[fname]) {
					frm.set_value(fname, val);
				}
			};
		}
	};

	direct_sync('custom_contract_discount');
	direct_sync('custom_approval_amount');
	direct_sync('custom_insurance_percentage');
	direct_sync('custom_maximum_limit');
	direct_sync('custom_approval_number');

	// Discover Table Name
	const cust_meta = frappe.get_meta('Customer');
	if (cust_meta) {
		const field = cust_meta.fields.find(
			(df) => df.fieldtype === 'Table' && df.options === 'Insurance Data',
		);
		if (field) d.custom_ins_table_field = field.fieldname;
	}

	load_insurance_from_invoice(frm, d);
	render_invoice_insurance_table(frm, d);
	load_previous_insurance(frm, d);
	d.show();
}

function render_invoice_insurance_table(frm, dialog) {
	const wrapper = dialog.fields_dict.invoice_insurance_html.$wrapper;
	wrapper.empty();
	dialog.invoice_insurance = dialog.invoice_insurance || [];
	const items = dialog.invoice_insurance;
	const is_locked = frm.doc.docstatus === 1 || frm.doc.docstatus === 2;

	let html = `
        <div class="mb-2 text-muted small">يمكنك إضافة أكثر من سجل، وسيتم اعتماد آخر سجل تلقائياً.</div>
        <table class="table table-bordered table-condensed" style="table-layout: fixed; width: 100%;">
            <thead><tr style="background:#f5f5f5;"><th style="width:40px;">#</th><th>Company</th><th>Policy</th><th>Patient</th><th>ID</th><th>Expiry</th><th style="width:80px;">إجراء</th></tr></thead>
            <tbody>
    `;

	if (!items.length) {
		html += `<tr><td colspan="7" class="text-center text-muted">لا يوجد بيانات مسجلة لهذه الفاتورة.</td></tr>`;
	} else {
		items.forEach((item, idx) => {
			html += `
                <tr>
                    <td>${idx + 1}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						item.company || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						item.policy_no || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						item.patient_name || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						item.id_no || '',
					)}</td>
                    <td style="word-wrap: break-word;">${
						frappe.format(item.expiry, { fieldtype: 'Date' }) || ''
					}</td>
                    <td>
                        ${
							is_locked
								? `<span class="text-muted">—</span>`
								: `<button class="btn btn-xs btn-danger si-ins-remove" data-idx="${idx}">${__(
										'حذف',
								  )}</button>`
						}
                    </td>
                </tr>
            `;
		});
	}
	html += `</tbody></table>`;
	wrapper.html(html);
	if (!is_locked) {
		wrapper.find('.si-ins-remove').on('click', function () {
			const idx = parseInt($(this).attr('data-idx'), 10);
			dialog.invoice_insurance.splice(idx, 1);
			const fn = INVOICE_INSURANCE_CHILD_FIELD;
			if (frm.doc && fn && Array.isArray(frm.doc[fn]) && frm.doc[fn].length > idx) {
				frm.doc[fn].splice(idx, 1);
				frm.refresh_field(fn);
			}
			render_invoice_insurance_table(frm, dialog);
		});
	}
}

function apply_insurance_to_dialog(dialog, item) {
	dialog.set_value('company', item.company);
	dialog.set_value('policy_no', item.policy_no);
	dialog.set_value('patient_name', item.patient_name);
	dialog.set_value('id_no', item.id_no);
	dialog.set_value('gender', item.gender);
	dialog.set_value('marital_status', item.marital_status);
	dialog.set_value('berth_date', item.berth_date);
	dialog.set_value('religion', item.religion);
	dialog.set_value('current_job', item.current_job);
	dialog.set_value('category', item.category);
	dialog.set_value('expiry', item.expiry);
	dialog.set_value('cat_name', item.cat_name);
	dialog.set_value('cat_type', item.cat_type);
	dialog.set_value('mem_no', item.mem_no);
	dialog.set_value('nationality', item.nationality);
	dialog.set_value('age', item.age);
	dialog.set_value('file_no', item.file_no);

	dialog.set_value('custom_insurance_company', item.custom_insurance_company);
	dialog.set_value('custom_contract_discount', item.custom_contract_discount);
	dialog.set_value('custom_approval_number', item.custom_approval_number);
	dialog.set_value('custom_approval_date', frappe.datetime.get_today());
	dialog.set_value('custom_approval_amount', item.custom_approval_amount);
	dialog.set_value('custom_insurance_percentage', item.custom_insurance_percentage);
	dialog.set_value('custom_maximum_limit', item.custom_maximum_limit);
}

function extract_insurance_from_row(row, FN) {
	return {
		company: row[FN.company],
		policy_no: row[FN.policy_no],
		patient_name: row[FN.patient_name],
		id_no: row[FN.id_no],
		gender: row[FN.gender],
		marital_status: row[FN.marital_status],
		berth_date: row[FN.berth_date],
		religion: row[FN.religion],
		current_job: row[FN.current_job],
		category: row[FN.category],
		expiry: row[FN.expiry],
		cat_name: row[FN.cat_name],
		cat_type: row[FN.cat_type],
		mem_no: row[FN.mem_no],
		nationality: row[FN.nationality],
		age: row[FN.age],
		file_no: row[FN.file_no],
		custom_insurance_company: row[FN.custom_insurance_company],
		custom_contract_discount: row[FN.custom_contract_discount],
		custom_approval_number: row[FN.custom_approval_number],
		custom_approval_date: row[FN.custom_approval_date],
		custom_approval_amount: row[FN.custom_approval_amount],
		custom_insurance_percentage: row[FN.custom_insurance_percentage],
		custom_maximum_limit: row[FN.custom_maximum_limit],
	};
}

function is_same_insurance_item(a, b) {
	const keys = [
		'company',
		'policy_no',
		'patient_name',
		'id_no',
		'gender',
		'marital_status',
		'berth_date',
		'religion',
		'current_job',
		'category',
		'expiry',
		'cat_name',
		'cat_type',
		'mem_no',
		'nationality',
		'age',
		'file_no',
		'custom_insurance_company',
		'custom_contract_discount',
		'custom_approval_number',
		'custom_approval_amount',
		'custom_insurance_percentage',
		'custom_maximum_limit',
	];
	return keys.every((k) => (a && a[k]) === (b && b[k]));
}

function is_same_insurance_row(row, item, FN) {
	const pairs = [
		['company', FN.company],
		['policy_no', FN.policy_no],
		['patient_name', FN.patient_name],
		['id_no', FN.id_no],
		['gender', FN.gender],
		['marital_status', FN.marital_status],
		['berth_date', FN.berth_date],
		['religion', FN.religion],
		['current_job', FN.current_job],
		['category', FN.category],
		['expiry', FN.expiry],
		['cat_name', FN.cat_name],
		['cat_type', FN.cat_type],
		['mem_no', FN.mem_no],
		['nationality', FN.nationality],
		['age', FN.age],
		['file_no', FN.file_no],
		['custom_insurance_company', FN.custom_insurance_company],
		['custom_contract_discount', FN.custom_contract_discount],
		['custom_approval_number', FN.custom_approval_number],
		['custom_approval_amount', FN.custom_approval_amount],
		['custom_insurance_percentage', FN.custom_insurance_percentage],
		['custom_maximum_limit', FN.custom_maximum_limit],
	];
	return pairs.every(([k, f]) => {
		if (!f) return (item && item[k]) == null;
		return (row && row[f]) === (item && item[k]);
	});
}

function load_insurance_from_invoice(frm, dialog) {
	const fn = INVOICE_INSURANCE_CHILD_FIELD;
	const FN = dialog.custom_ins_col_map || INSURANCE_FIELDNAMES;
	const rows = (frm.doc && frm.doc[fn]) || [];
	if (!rows.length) {
		if (dialog.fields_dict.custom_approval_number && frm.doc.custom_approval_number != null) {
			dialog.set_value('custom_approval_number', frm.doc.custom_approval_number);
		}
		if (dialog.fields_dict.custom_approval_date) {
			dialog.set_value('custom_approval_date', frappe.datetime.get_today());
		}
		return;
	}

	const items = rows.map((row) => extract_insurance_from_row(row, FN));
	items.forEach((it) => {
		if (it.custom_approval_number == null)
			it.custom_approval_number = frm.doc.custom_approval_number;
		it.custom_approval_date = frappe.datetime.get_today();
	});
	dialog.invoice_insurance = items;
	const item = items[items.length - 1];
	if (item) {
		apply_insurance_to_dialog(dialog, item);
		dialog.__auto_loaded = true;
	}
}

function set_insurance_on_invoice(dialog) {
	const v = dialog.get_values();
	const data = {
		company: v.company,
		policy_no: v.policy_no,
		patient_name: v.patient_name,
		id_no: v.id_no,
		gender: v.gender,
		marital_status: v.marital_status,
		berth_date: v.berth_date,
		religion: v.religion,
		current_job: v.current_job,
		category: v.category,
		expiry: v.expiry,
		cat_name: v.cat_name,
		cat_type: v.cat_type,
		mem_no: v.mem_no,
		nationality: v.nationality,
		age: v.age,
		file_no: v.file_no,
		custom_insurance_company: v.custom_insurance_company,
		custom_contract_discount: v.custom_contract_discount,
		custom_approval_number: v.custom_approval_number,
		custom_approval_date: frappe.datetime.get_today(),
		custom_approval_amount: v.custom_approval_amount,
		custom_insurance_percentage: v.custom_insurance_percentage,
		custom_maximum_limit: v.custom_maximum_limit,
	};
	dialog.invoice_insurance = dialog.invoice_insurance || [];
	const last = dialog.invoice_insurance[dialog.invoice_insurance.length - 1];
	if (!last || !is_same_insurance_item(last, data)) {
		dialog.invoice_insurance.push(data);
	}
}

function save_new_insurance(frm, dialog) {
	const v = dialog.get_values();
	if (!v) return;

	try {
		set_insurance_on_invoice(dialog);
	} catch (e) {
		frappe.msgprint({ title: __('تحذير'), message: e.message, indicator: 'orange' });
		return;
	}

	const item = dialog.invoice_insurance[dialog.invoice_insurance.length - 1];

	frappe.call({
		method: 'frappe.client.get',
		args: { doctype: 'Customer', name: frm.doc.customer },
		callback(r) {
			const customer = r.message;
			if (!customer) return;

			const target_field = dialog.custom_ins_table_field || CUSTOMER_INSURANCE_CHILD_FIELD;
			const FN = dialog.custom_ins_col_map || INSURANCE_FIELDNAMES;

			customer[target_field] = customer[target_field] || [];
			const last_row = customer[target_field][customer[target_field].length - 1];
			const should_add = !last_row || !is_same_insurance_row(last_row, item, FN);

			if (should_add) {
				const new_row = {
					doctype: 'Insurance Data',
					parent: customer.name,
					parenttype: 'Customer',
					parentfield: target_field,
					so: frm.doc.name || '',
				};
				new_row[FN.company] = item.company;
				new_row[FN.policy_no] = item.policy_no;
				new_row[FN.patient_name] = item.patient_name;
				new_row[FN.id_no] = item.id_no;
				if (FN.gender) new_row[FN.gender] = item.gender;
				if (FN.marital_status) new_row[FN.marital_status] = item.marital_status;
				if (FN.berth_date) new_row[FN.berth_date] = item.berth_date;
				if (FN.religion) new_row[FN.religion] = item.religion;
				if (FN.current_job) new_row[FN.current_job] = item.current_job;
				new_row[FN.category] = item.category;
				new_row[FN.expiry] = item.expiry;
				new_row[FN.cat_name] = item.cat_name;
				new_row[FN.cat_type] = item.cat_type;
				new_row[FN.mem_no] = item.mem_no;
				new_row[FN.nationality] = item.nationality;
				new_row[FN.age] = item.age;
				new_row[FN.file_no] = item.file_no;

				if (FN.custom_insurance_company)
					new_row[FN.custom_insurance_company] = item.custom_insurance_company;
				if (FN.custom_contract_discount)
					new_row[FN.custom_contract_discount] = item.custom_contract_discount;
				if (FN.custom_approval_number)
					new_row[FN.custom_approval_number] = item.custom_approval_number;
				if (FN.custom_approval_date)
					new_row[FN.custom_approval_date] = item.custom_approval_date;
				if (FN.custom_approval_amount)
					new_row[FN.custom_approval_amount] = item.custom_approval_amount;
				if (FN.custom_insurance_percentage)
					new_row[FN.custom_insurance_percentage] = item.custom_insurance_percentage;
				if (FN.custom_maximum_limit)
					new_row[FN.custom_maximum_limit] = item.custom_maximum_limit;

				customer[target_field].push(new_row);

				frappe.call({
					method: 'frappe.client.save',
					args: { doc: customer },
					callback() {
						finish_save();
						dialog.hide();
					},
					error(err) {
						console.warn('Save failed, linking to SI only', err);
						frappe.msgprint({
							title: __('تنبيه'),
							message: __(
								'تعذر الحفظ في ملف العميل (بيانات غير موجودة أو صلاحيات)، تم الربط بالفاتورة فقط.',
							),
							indicator: 'orange',
						});
						finish_save();
					},
				});
			} else {
				finish_save();
				dialog.hide();
			}

			function finish_save() {
				link_insurance_to_sales_invoice(frm, item, FN);
				load_insurance_from_invoice(frm, dialog);
				render_invoice_insurance_table(frm, dialog);
				load_previous_insurance(frm, dialog);
			}
		},
	});
}

function link_insurance_to_sales_invoice(frm, item, field_map) {
	const fn = INVOICE_INSURANCE_CHILD_FIELD;
	const FN = field_map || INSURANCE_FIELDNAMES;
	const parent_updates = {};
	if (item.custom_insurance_company)
		parent_updates['custom_insurance_company'] = item.custom_insurance_company;
	if (item.custom_contract_discount)
		parent_updates['custom_contract_discount'] = item.custom_contract_discount;
	if (item.custom_approval_number)
		parent_updates['custom_approval_number'] = item.custom_approval_number;
	if (item.custom_approval_date)
		parent_updates['custom_approval_date'] = item.custom_approval_date;
	if (item.custom_approval_amount)
		parent_updates['custom_approval_amount'] = item.custom_approval_amount;
	if (item.custom_insurance_percentage)
		parent_updates['custom_insurance_percentage'] = item.custom_insurance_percentage;
	if (item.custom_maximum_limit)
		parent_updates['custom_maximum_limit'] = item.custom_maximum_limit;

	if (Object.keys(parent_updates).length > 0) {
		frm.set_value(parent_updates);
	}

	if (!fn || !frm.fields_dict[fn]) {
		console.warn('Insurance child table not found on Sales Invoice.');
		return;
	}
	frm.doc[fn] = frm.doc[fn] || [];
	const last_row = frm.doc[fn][frm.doc[fn].length - 1];
	let row;
	if (!last_row || !is_same_insurance_row(last_row, item, FN)) {
		row = frm.add_child(fn);
	} else {
		row = last_row;
	}

	row[FN.company] = item.company;
	row[FN.policy_no] = item.policy_no;
	row[FN.patient_name] = item.patient_name;
	row[FN.id_no] = item.id_no;
	if (FN.gender) row[FN.gender] = item.gender;
	if (FN.marital_status) row[FN.marital_status] = item.marital_status;
	if (FN.berth_date) row[FN.berth_date] = item.berth_date;
	if (FN.religion) row[FN.religion] = item.religion;
	if (FN.current_job) row[FN.current_job] = item.current_job;
	row[FN.category] = item.category;
	row[FN.expiry] = item.expiry;
	row[FN.cat_name] = item.cat_name;
	row[FN.cat_type] = item.cat_type;
	row[FN.mem_no] = item.mem_no;
	row[FN.nationality] = item.nationality;
	row[FN.age] = item.age;
	row[FN.file_no] = item.file_no;

	if (FN.custom_insurance_company)
		row[FN.custom_insurance_company] = item.custom_insurance_company;
	if (FN.custom_contract_discount)
		row[FN.custom_contract_discount] = item.custom_contract_discount;
	if (FN.custom_approval_number) row[FN.custom_approval_number] = item.custom_approval_number;
	if (FN.custom_approval_date) row[FN.custom_approval_date] = item.custom_approval_date;
	if (FN.custom_approval_amount) row[FN.custom_approval_amount] = item.custom_approval_amount;
	if (FN.custom_insurance_percentage)
		row[FN.custom_insurance_percentage] = item.custom_insurance_percentage;
	if (FN.custom_maximum_limit) row[FN.custom_maximum_limit] = item.custom_maximum_limit;

	frm.refresh_field(fn);
}

function load_previous_insurance(frm, dialog) {
	const wrapper = dialog.fields_dict.previous_insurance_html.$wrapper;
	wrapper.empty();
	if (!frm.doc.customer) {
		wrapper.html(`<div class="text-muted small">اختر العميل أولاً.</div>`);
		return;
	}
	const is_locked = frm.doc.docstatus === 1 || frm.doc.docstatus === 2;

	frappe.call({
		method: 'frappe.client.get',
		args: { doctype: 'Customer', name: frm.doc.customer },
		callback(r) {
			const customer = r.message;
			if (!customer) {
				wrapper.html(
					`<div class="text-muted small">لم يتم العثور على بيانات العميل.</div>`,
				);
				return;
			}

			const target_field = dialog.custom_ins_table_field || CUSTOMER_INSURANCE_CHILD_FIELD;
			let arr = customer[target_field] || [];
			const FN = dialog.custom_ins_col_map || INSURANCE_FIELDNAMES;

			if (!arr.length) {
				wrapper.html(`<div class="text-muted small">لا توجد بيانات سابقة.</div>`);
				return;
			}

			let html = `
                <table class="table table-bordered table-condensed" style="table-layout: fixed; width: 100%;">
                    <thead><tr style="background:#f5f5f5;"><th style="width:40px;">#</th><th>Company</th><th>Policy</th><th>Patient</th><th>ID</th><th>Expiry</th><th style="width:80px;">اختيار</th></tr></thead>
                    <tbody>
            `;
			arr.forEach((row, idx) => {
				html += `
                    <tr>
                        <td>${idx + 1}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.company] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.policy_no] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.patient_name] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.id_no] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${
							frappe.format(row[FN.expiry], { fieldtype: 'Date' }) || ''
						}</td>
                        <td>
                            ${
								is_locked
									? `<span class="text-muted">—</span>`
									: `<button class="btn btn-xs btn-primary si-ins-use" data-idx="${idx}">${__(
											'استخدام',
									  )}</button>`
							}
                        </td>
                    </tr>
                `;
			});
			html += `</tbody></table>`;
			wrapper.html(html);

			const fn = INVOICE_INSURANCE_CHILD_FIELD;
			const invoice_rows = (frm.doc && frm.doc[fn]) || [];
			if (!invoice_rows.length && !dialog.__auto_loaded) {
				const last = arr[arr.length - 1];
				const item = extract_insurance_from_row(last, FN);
				apply_insurance_to_dialog(dialog, item);
				dialog.__auto_loaded = true;
			}

			if (!is_locked) {
				wrapper.find('.si-ins-use').on('click', function () {
					const idx = parseInt($(this).attr('data-idx'), 10);
					const row = arr[idx];
					const item = extract_insurance_from_row(row, FN);
					apply_insurance_to_dialog(dialog, item);
				});
			}
		},
	});
}
//
// --- Allow total column width up to 20 for Sales Invoice Item ---

frappe.ui.form.on('Sales Invoice', {
	refresh(frm) {
		// احصل على الـ DocType الخاص بالجدول الفرعي
		const child_doctype = 'Sales Invoice Item';

		// استرجاع الحقول الخاصة بالجدول
		const fields = frappe.meta.get_docfield(child_doctype);

		if (!fields) return;

		// احسب مجموع الأعمدة الحالية
		let total_col = 0;
		fields.forEach((f) => {
			if (f.in_list_view && f.columns) total_col += f.columns;
		});

		// تجاوز الحد الافتراضي إذا كان <= 20
		if (total_col > 10 && total_col <= 20) {
			console.log(`✅ السماح بمجموع أعمدة ${total_col} (تجاوز الحد 10 بنجاح)`);
		} else if (total_col > 20) {
			frappe.msgprint(
				`⚠️ مجموع الأعمدة (${total_col}) يتجاوز الحد الأقصى (20). يرجى التعديل.`,
			);
		}
	},
});

console.log('📏 Custom patch loaded: max column width = 20 for Sales Invoice Item');
//
frappe.ui.form.on('Sales Invoice', {
	onload(frm) {
		(frm.doc.items || []).forEach((row) => {
			if (!row._original_custom_discount2 && row.custom_discount2 > 0) {
				row._original_custom_discount2 = row.custom_discount2;
			}
		});
	},

	after_save(frm) {
		let updated = false;

		(frm.doc.items || []).forEach((row) => {
			if (!row._original_custom_discount2 && row.custom_discount2 > 0) {
				row._original_custom_discount2 = row.custom_discount2;

				if (!row.custom_discount_code) {
					row.custom_discount_code = generateRandomCode(10);
				}

				updated = true;
			}
		});

		if (updated) frm.save();
	},

	validate(frm) {
		(frm.doc.items || []).forEach((row) => {
			if (!row._original_custom_discount2 && row.custom_discount2 > 0) {
				row._original_custom_discount2 = row.custom_discount2;

				if (!row.custom_discount_code) {
					row.custom_discount_code = generateRandomCode(10);
				}
			}
		});
	},

	refresh(frm) {
		// لا تحقق من الكود أو الموافقة
	},

	before_submit(frm) {
		// لا تحقق من الكود أو الموافقة
	},
});

frappe.ui.form.on('Sales Invoice Item', {
	custom_discount2(frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		const original = Number(row._original_custom_discount2) || 0;
		const current = Number(row.custom_discount2) || 0;

		// إذا تم إدخال خصم لأول مرة
		if (!row._original_custom_discount2 && current > 0) {
			frappe.model.set_value(cdt, cdn, '_original_custom_discount2', current);

			if (!row.custom_discount_code) {
				const code = generateRandomCode(10);
				frappe.model.set_value(cdt, cdn, 'custom_discount_code', code);
			}

			return;
		}

		// منع تعديل الخصم بعد إدخاله
		if (row._original_custom_discount2 && current !== original) {
			frappe.msgprint(__('🚫 لا يمكنك تعديل الخصم بعد إدخاله. تم إرجاع القيمة الأصلية.'));
			frappe.model.set_value(cdt, cdn, 'custom_discount2', row._original_custom_discount2);
		}
	},

	custom_discount_code_approved(frm, cdt, cdn) {
		// لا شيء هنا أيضًا
	},

	items_add(frm, cdt, cdn) {
		frappe.model.set_value(cdt, cdn, '_original_custom_discount2', null);
		frappe.model.set_value(cdt, cdn, 'custom_discount_code', null);
		frappe.model.set_value(cdt, cdn, 'custom_discount_code_approved', null);
	},
});

// توليد كود خصم عشوائي
function generateRandomCode(length) {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let result = '';
	for (let i = 0; i < length; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}
//
frappe.ui.form.on('Sales Invoice', {
	before_submit(frm) {
		let errors = [];

		(frm.doc.items || []).forEach((row) => {
			if ((row.custom_discount_code || '') !== (row.custom__discount_code_approved || '')) {
				errors.push(`🚫 الصف ${row.idx}: كود الخصم غير صحيح أو غير معتمد.`);
			}
		});

		if (errors.length > 0) {
			frappe.throw({
				title: 'خطأ في أكواد الخصم',
				message: errors.join('<br>'),
			});
		}
	},
});
//
frappe.ui.form.on('Sales Invoice', {
	onload: function (frm) {
		if (frm.doc.docstatus === 0 && frappe.user.has_role('Sales Manager')) {
			update_discount_button(frm);
		}
	},
	refresh: function (frm) {
		if (frm.doc.docstatus === 0 && frappe.user.has_role('Sales Manager')) {
			setTimeout(() => {
				update_discount_button(frm);
			}, 300);
		}
	},
	items_on_form_render: function (frm) {
		update_discount_button(frm);
	},
	items_on_change: function (frm) {
		update_discount_button(frm);
	},
	after_save: function (frm) {
		setTimeout(() => {
			update_discount_button(frm);
		}, 300);
	},
});

let discount_button = null;

function update_discount_button(frm) {
	if (!frappe.user.has_role('Sales Manager')) {
		if (discount_button) {
			discount_button.remove();
			discount_button = null;
		}
		return;
	}

	const pending_count = count_pending_discounts(frm);

	if (pending_count === 0) {
		if (discount_button) {
			discount_button.remove();
			discount_button = null;
		}
		return;
	}

	if (discount_button) {
		discount_button.remove();
	}

	discount_button = frm.add_custom_button(`👓 خصومات (${pending_count})`, function () {
		show_individual_discount_dialogs(frm);
	});
}

function count_pending_discounts(frm) {
	return (frm.doc.items || []).filter((item) => {
		if (item.custom_discount2 <= 0) return false;
		const key = get_local_key(frm.doc.name, item.name);
		const decision = localStorage.getItem(key);
		return decision !== 'approved' && decision !== 'rejected';
	}).length;
}

function show_individual_discount_dialogs(frm) {
	let rows = (frm.doc.items || []).filter((item) => {
		if (item.custom_discount2 <= 0) return false;
		const key = get_local_key(frm.doc.name, item.name);
		const decision = localStorage.getItem(key);
		return decision !== 'approved' && decision !== 'rejected';
	});

	if (rows.length === 0) {
		frappe.msgprint('✅ لا توجد خصومات بحاجة للموافقة.');
		return;
	}

	function show_next_dialog(index) {
		if (index >= rows.length) {
			frm.save().then(() => {
				frappe.msgprint('✅ تم الانتهاء من مراجعة الخصومات.');
				setTimeout(() => update_discount_button(frm), 300);
			});
			return;
		}

		const row = rows[index];
		const key = get_local_key(frm.doc.name, row.name);

		const branch = frm.doc.branch || frm.doc.custom_branch || 'غير محدد';

		const d = new frappe.ui.Dialog({
			title: `🔔 طلب خصم اضافي`,
			fields: [
				{
					fieldtype: 'HTML',
					options: `
                        <div style="margin-bottom: 15px;">
                            <b>الصنف:</b> ${row.item_code}<br>
                            <b>الخصم:</b> ${format_currency(row.custom_discount2)}<br>
                            <b>كود الخصم:</b> ${row.custom_discount_code || 'غير متوفر'}<br>
                            <b>الفرع:</b> ${branch}
                        </div>`,
				},
			],
			primary_action_label: '✅ موافق',
			primary_action: function () {
				frappe.model.set_value(row.doctype, row.name, 'custom_discount2_approved', 1);
				frappe.model.set_value(
					row.doctype,
					row.name,
					'custom__discount_code_approved',
					row.custom_discount_code || '',
				);
				localStorage.setItem(key, 'approved');
				d.hide();
				update_discount_button(frm);
				show_next_dialog(index + 1);
			},
			secondary_action_label: '❌ غير موافق',
			secondary_action: function () {
				localStorage.setItem(key, 'rejected');
				d.hide();
				update_discount_button(frm);
				show_next_dialog(index + 1);
			},
		});

		d.show();
	}

	show_next_dialog(0);
}

function get_local_key(invoice_name, item_name) {
	return `discount_decision_${invoice_name}_${item_name}`;
}
//
frappe.ui.form.on('Sales Invoice', {
	onload(frm) {
		calculate_deductible_amount(frm);
	},
	custom_approval_amount(frm) {
		calculate_deductible_amount(frm);
	},
	custom_insurance_percentage(frm) {
		calculate_deductible_amount(frm);
	},
	custom_maximum_limit(frm) {
		calculate_deductible_amount(frm);
	},
});

function calculate_deductible_amount(frm) {
	let approval = frm.doc.custom_approval_amount || 0;
	let percentage = frm.doc.custom_insurance_percentage || 0;
	let max_limit = frm.doc.custom_maximum_limit || 0;

	let decimal_percentage = percentage / 100;
	let result = approval * decimal_percentage;

	if (max_limit > 0 && max_limit < result) {
		frm.set_value('custom_deductible_amount', max_limit);
	} else {
		frm.set_value('custom_deductible_amount', result);
	}
}
//
frappe.ui.form.on('Sales Invoice', {
	custom_insurance_company: function (frm) {
		// تحقق من وجود شركة التأمين
		if (frm.doc.custom_insurance_company) {
			frappe.db
				.get_doc('Insurance Company', frm.doc.custom_insurance_company)
				.then((doc) => {
					frm.set_value('custom_contract_discount', doc.custom_contract_discount);

					// اجعل الحقل "للقراءة فقط" إذا كانت هناك نسبة
					if (doc.custom_contract_discount) {
						frm.set_df_property('custom_insurance_company', 'read_only', true);
					}
				})
				.catch((err) => {
					frappe.msgprint(__('لم يتم العثور على شركة التأمين المحددة'));
					console.error(err);
				});
		} else {
			frm.set_value('custom_contract_discount', null);

			// اجعل الحقل قابلًا للتعديل إذا لم يتم تحديد شركة التأمين
			frm.set_df_property('custom_insurance_company', 'read_only', false);
		}
	},

	custom_contract_discount: function (frm) {
		// إذا تم مسح النسبة، اجعل الحقل قابلًا للتعديل
		if (!frm.doc.custom_contract_discount) {
			frm.set_df_property('custom_insurance_company', 'read_only', false);
		}
	},
});
//
frappe.ui.form.on('Sales Invoice', {
	validate: function (frm) {
		let total = 0;

		// جمع قيم custom_approval_amount في جدول البنود
		frm.doc.items.forEach(function (row) {
			total += row.custom_approval_amount || 0;
		});

		// مقارنة الإجمالي مع الحقل الرئيسي
		if (total > (frm.doc.custom_approval_amount || 0)) {
			frappe.throw(
				__('إجمالي مبلغ الموافقة في البنود يتجاوز المبلغ المحدد في فاتورة المبيعات.'),
			);
		}
	},
});
//

frappe.ui.form.on('Sales Invoice', {
	refresh: function (frm) {
		// ✅ تأجيل التطبيق حتى يتم بناء جدول الأصناف فعليًا
		setTimeout(() => {
			// إزالة أي نسخ قديمة من النمط
			$('style[data-custom="items-grid-style"]').remove();

			const customStyle = `
                <style data-custom="items-grid-style">
                    /* ✅ رأس جدول الأصناف فقط */
                    div[data-fieldname="items"] .grid-heading-row {
                        min-height: 60px !important;
                        height: 60px !important;
                        align-items: stretch !important;
                        table-layout: fixed !important;
                        width: 100% !important;
                        overflow: hidden !important;
                    }

                    /* ✅ خلايا الهيدر لجدول الأصناف */
                    div[data-fieldname="items"] .grid-heading-row .grid-label,
                    div[data-fieldname="items"] .grid-heading-row .grid-static-col,
                    div[data-fieldname="items"] .grid-heading-row .grid-label span,
                    div[data-fieldname="items"] .grid-heading-row .grid-static-col .static-area {
                        display: -webkit-box !important;
                        -webkit-line-clamp: 2 !important;
                        -webkit-box-orient: vertical !important;
                        overflow: hidden !important;
                        text-overflow: ellipsis !important;
                        white-space: normal !important;
                        word-break: break-word !important;
                        text-align: center !important;
                        min-width: 0 !important;
                        height: 100% !important;
                        line-height: 1.4 !important;
                        padding-top: 2px !important;
                        padding-bottom: 14px !important;
                        box-sizing: border-box !important;
                        justify-content: center !important;
                        align-items: flex-start !important;
                    }

                    /* ✅ خلايا الصفوف في جدول الأصناف فقط */
                    div[data-fieldname="items"] .grid-row .data-row .data-col {
                        text-align: center !important;
                        vertical-align: middle !important;
                        line-height: 1.4 !important;
                        padding-top: 6px !important;
                        padding-bottom: 6px !important;
                        box-sizing: border-box !important;
                        word-break: break-word !important;
                    }
                </style>
            `;

			$(customStyle).appendTo('head');
		}, 500); // تأخير نصف ثانية لضمان تحميل الجدول
	},
});
//
frappe.ui.form.on('Sales Invoice', {
	refresh: function (frm) {
		// إضافة event listener لصفوف العناصر
		add_item_tooltip(frm);
	},

	set_warehouse: function (frm) {
		// تحديث الـ tooltip عند تغيير المستودع الافتراضي
		add_item_tooltip(frm);
	},
});

function add_item_tooltip(frm) {
	// الانتظار حتى يتم تحميل جدول العناصر
	setTimeout(function () {
		// إزالة event listeners السابقة
		$('[data-fieldname="items"]').off('mouseover', '[data-fieldname="item_code"]');

		// إضافة event listeners جديدة
		$('[data-fieldname="items"]').on('mouseover', '[data-fieldname="item_code"]', function () {
			let row = $(this).closest('.grid-row');
			let item_code = row.find('[data-fieldname="item_code"] input').val();
			let set_warehouse = frm.doc.set_warehouse;

			if (item_code && set_warehouse) {
				get_item_details(item_code, set_warehouse, row, frm);
			} else if (item_code) {
				// إذا لم يتم تحديد مستودع افتراضي
				show_item_tooltip(
					{
						item_code: item_code,
						item_name: row.find('[data-fieldname="item_name"] input').val(),
						description: row.find('[data-fieldname="description"] textarea').val(),
					},
					null,
					row,
				);
			}
		});
	}, 1000);
}

function get_item_details(item_code, warehouse, row, frm) {
	// الحصول على بيانات الصنف
	frappe.call({
		method: 'frappe.client.get_value',
		args: {
			doctype: 'Item',
			filters: { name: item_code },
			fieldname: ['item_name', 'item_code', 'description', 'stock_uom'],
		},
		callback: function (r) {
			if (r.message) {
				// الحصول على المخزون من المستودع المحدد
				get_item_stock(item_code, warehouse, r.message, row, frm);
			}
		},
	});
}

function get_item_stock(item_code, warehouse, item_data, row, frm) {
	frappe.call({
		method: 'erpnext.stock.utils.get_stock_balance',
		args: {
			item_code: item_code,
			warehouse: warehouse,
		},
		callback: function (r) {
			let stock_balance = r.message !== undefined ? r.message : 0;
			show_item_tooltip(item_data, stock_balance, row, warehouse);
		},
	});
}

function show_item_tooltip(item_data, stock_balance, row, warehouse) {
	// إزالة أي tooltip موجود مسبقاً
	$('.custom-item-tooltip').remove();

	let tooltip_content = `
        <div class="custom-item-tooltip" style="
            position: absolute;
            background: #fff;
            border: 1px solid #d1d8dd;
            padding: 12px;
            border-radius: 4px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.15);
            z-index: 1000;
            max-width: 320px;
            font-size: 12px;
            line-height: 1.5;
        ">
            <div style="margin-bottom: 5px;">
                <strong>كود الصنف:</strong> ${item_data.item_code || ''}
            </div>
            <div style="margin-bottom: 5px;">
                <strong>اسم الصنف:</strong> ${item_data.item_name || ''}
            </div>
    `;

	if (warehouse && stock_balance !== null) {
		tooltip_content += `
            <div style="margin-bottom: 5px; color: #2490ef;">
                <strong>المخزون في ${warehouse}:</strong> ${stock_balance} ${
			item_data.stock_uom || ''
		}
            </div>
        `;
	} else if (!warehouse) {
		tooltip_content += `
            <div style="margin-bottom: 5px; color: #e74c3c;">
                <strong>ملاحظة:</strong> لم يتم تحديد مستودع افتراضي
            </div>
        `;
	}

	if (item_data.description) {
		tooltip_content += `
            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
                <strong>الوصف:</strong><br>${item_data.description}
            </div>
        `;
	}

	tooltip_content += `</div>`;

	$(tooltip_content).appendTo('body');

	// تحديد موقع الـ tooltip
	let position = row.find('[data-fieldname="item_code"]').offset();
	let tooltip = $('.custom-item-tooltip');

	tooltip.css({
		left: position.left + 220,
		top: position.top - 10,
	});
}

// إزالة الـ tooltip عند تحريك الماوس بعيداً
$(document).on('mouseleave', '[data-fieldname="item_code"]', function () {
	setTimeout(function () {
		$('.custom-item-tooltip').remove();
	}, 300);
});
